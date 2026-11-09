// IPC for window.api.orcaCloudEnvironments. Every call answers a Result so the renderer never sees
// a thrown control-plane error; build watches stream to the window that opened them.
import { randomUUID } from 'node:crypto'
import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { z } from 'zod'
import { getRepoDialableSshTargetId } from '../../../shared/execution-host'
import type { Repo } from '../../../shared/repo-types'
import {
  ORCA_CLOUD_ENVIRONMENT_BUILD_EVENT_CHANNEL,
  type OrcaCloudEnvironmentBuildEvent,
  type OrcaCloudEnvironmentResult
} from '../../../shared/hosted-sandbox/hosted-environment-api'
import { hostedEnvironmentError } from '../../../shared/hosted-sandbox/hosted-environment-errors'
import {
  HOSTED_ENVIRONMENT_BUILD_ID,
  HOSTED_ENVIRONMENT_ID,
  HostedEnvironmentCreateInputSchema,
  HostedEnvironmentUpdateInputSchema
} from '../../../shared/hosted-sandbox/hosted-environment-wire'
import { watchHostedEnvironmentBuild } from '../../hosted-sandbox/environments/hosted-environment-build-watch'
import { installHostedEnvironmentService } from '../../hosted-sandbox/environments/hosted-environment-install'
import { readRepoSetupImports } from '../../hosted-sandbox/environments/hosted-environment-repo-imports'
import {
  hostedEnvironmentResult,
  type HostedEnvironmentService
} from '../../hosted-sandbox/environments/hosted-environment-service'

const EnvId = z.string().regex(HOSTED_ENVIRONMENT_ID)
const BuildId = z.string().regex(HOSTED_ENVIRONMENT_BUILD_ID)
// A settings page shows one build log at a time; more than this per window is a leak.
const MAX_WATCHES_PER_SENDER = 8

const CHANNELS = [
  'orcaCloudEnvironments:isConfigured',
  'orcaCloudEnvironments:list',
  'orcaCloudEnvironments:get',
  'orcaCloudEnvironments:create',
  'orcaCloudEnvironments:update',
  'orcaCloudEnvironments:remove',
  'orcaCloudEnvironments:startBuild',
  'orcaCloudEnvironments:cancelBuild',
  'orcaCloudEnvironments:activateBuild',
  'orcaCloudEnvironments:staleness',
  'orcaCloudEnvironments:watchBuild',
  'orcaCloudEnvironments:unwatchBuild',
  'orcaCloudEnvironments:readRepoSetupImports'
] as const

type Watch = {
  senderId: number
  stop: () => void
  /** Sends one last event to the renderer that owns the watch. */
  notify: (event: OrcaCloudEnvironmentBuildEvent['event']) => void
}

export type OrcaCloudEnvironmentRepoSource = { getRepos(): Repo[] }

const EVICTED_MESSAGE =
  'Stopped following this build: too many build logs are open in this window. Reopen it to resume.'

// Main's repo store, set by whoever wires the handlers; without it no repo can be imported from.
let repoSource: OrcaCloudEnvironmentRepoSource | null = null

/** Local checkouts the user added to Orca; SSH-backed repos never fall through to local reads. */
function registeredLocalRepoPaths(): string[] {
  return (repoSource?.getRepos() ?? [])
    .filter((repo) => !getRepoDialableSshTargetId(repo))
    .map((repo) => repo.path)
}

function invalid<T>(field: string): OrcaCloudEnvironmentResult<T> {
  return { ok: false, error: hostedEnvironmentError('invalid_request', field) }
}

let registered = false

/** Idempotent: startup may wire Orca Cloud more than once. */
export function registerOrcaCloudEnvironmentHandlers(
  options: { repos?: OrcaCloudEnvironmentRepoSource; service?: HostedEnvironmentService } = {}
): void {
  if (options.repos) {
    repoSource = options.repos
  }
  if (registered) {
    return
  }
  const service = options.service ?? installHostedEnvironmentService()
  registered = true
  for (const channel of CHANNELS) {
    ipcMain.removeHandler(channel)
  }
  const watches = new Map<string, Watch>()
  const trackedSenders = new Set<number>()

  const stopWatch = (watchId: string): void => {
    const watch = watches.get(watchId)
    if (watch) {
      watches.delete(watchId)
      watch.stop()
    }
  }

  const trackSender = (sender: WebContents): void => {
    if (trackedSenders.has(sender.id)) {
      return
    }
    trackedSenders.add(sender.id)
    const senderId = sender.id
    const cleanup = (): void => {
      trackedSenders.delete(senderId)
      for (const [watchId, watch] of watches) {
        if (watch.senderId === senderId) {
          stopWatch(watchId)
        }
      }
    }
    sender.once('destroyed', cleanup)
    // A reload keeps the WebContents but drops every renderer listener.
    sender.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) {
        for (const [watchId, watch] of watches) {
          if (watch.senderId === senderId) {
            stopWatch(watchId)
          }
        }
      }
    })
  }

  ipcMain.handle('orcaCloudEnvironments:isConfigured', () => service.isConfigured())

  ipcMain.handle('orcaCloudEnvironments:list', () =>
    hostedEnvironmentResult(() => service.client().list())
  )

  ipcMain.handle('orcaCloudEnvironments:get', (_event, envId: unknown) => {
    const id = EnvId.safeParse(envId)
    return id.success
      ? hostedEnvironmentResult(() => service.client().get(id.data))
      : invalid('environment_id')
  })

  ipcMain.handle('orcaCloudEnvironments:create', (_event, input: unknown) => {
    const parsed = HostedEnvironmentCreateInputSchema.safeParse(input)
    if (!parsed.success) {
      return invalid(parsed.error.issues[0]?.path.join('.') || 'input')
    }
    return hostedEnvironmentResult(async () => ({
      environment: await service.client().create(parsed.data)
    }))
  })

  ipcMain.handle('orcaCloudEnvironments:update', (_event, envId: unknown, patch: unknown) => {
    const id = EnvId.safeParse(envId)
    const parsed = HostedEnvironmentUpdateInputSchema.safeParse(patch)
    if (!id.success) {
      return invalid('environment_id')
    }
    if (!parsed.success) {
      return invalid(parsed.error.issues[0]?.path.join('.') || 'patch')
    }
    return hostedEnvironmentResult(async () => ({
      environment: await service.client().update(id.data, parsed.data)
    }))
  })

  ipcMain.handle('orcaCloudEnvironments:remove', (_event, envId: unknown) => {
    const id = EnvId.safeParse(envId)
    return id.success
      ? hostedEnvironmentResult(() => service.client().remove(id.data))
      : invalid('environment_id')
  })

  ipcMain.handle('orcaCloudEnvironments:startBuild', (_event, envId: unknown) => {
    const id = EnvId.safeParse(envId)
    return id.success
      ? hostedEnvironmentResult(async () => ({ build: await service.client().startBuild(id.data) }))
      : invalid('environment_id')
  })

  ipcMain.handle(
    'orcaCloudEnvironments:cancelBuild',
    (_event, envId: unknown, buildId: unknown) => {
      const id = EnvId.safeParse(envId)
      const bid = BuildId.safeParse(buildId)
      if (!id.success || !bid.success) {
        return invalid(id.success ? 'build_id' : 'environment_id')
      }
      return hostedEnvironmentResult(async () => ({
        build: await service.client().cancelBuild(id.data, bid.data)
      }))
    }
  )

  ipcMain.handle(
    'orcaCloudEnvironments:activateBuild',
    (_event, envId: unknown, buildId: unknown) => {
      const id = EnvId.safeParse(envId)
      const bid = BuildId.safeParse(buildId)
      if (!id.success || !bid.success) {
        return invalid(id.success ? 'build_id' : 'environment_id')
      }
      return hostedEnvironmentResult(async () => ({
        environment: await service.client().activateBuild(id.data, bid.data)
      }))
    }
  )

  ipcMain.handle('orcaCloudEnvironments:staleness', (_event, envId: unknown, refresh: unknown) => {
    const id = EnvId.safeParse(envId)
    return id.success
      ? hostedEnvironmentResult(async () => ({
          staleness: await service.client().staleness(id.data, refresh === true)
        }))
      : invalid('environment_id')
  })

  ipcMain.handle(
    'orcaCloudEnvironments:watchBuild',
    (event: IpcMainInvokeEvent, envId: unknown, buildId: unknown) => {
      const id = EnvId.safeParse(envId)
      const bid = BuildId.safeParse(buildId)
      if (!id.success || !bid.success) {
        return invalid(id.success ? 'build_id' : 'environment_id')
      }
      return hostedEnvironmentResult(async () => {
        const client = service.client()
        const sender = event.sender
        trackSender(sender)
        const senderWatches = [...watches].filter(([, watch]) => watch.senderId === sender.id)
        // Oldest first (Map keeps insertion order): drop the ones a leaky caller forgot.
        for (const [watchId, evicted] of senderWatches.slice(
          0,
          Math.max(0, senderWatches.length - MAX_WATCHES_PER_SENDER + 1)
        )) {
          // Tell the evicted log why it went quiet before stopping it.
          evicted.notify({ type: 'error', message: EVICTED_MESSAGE })
          stopWatch(watchId)
        }
        const watchId = randomUUID()
        const send = (streamEvent: OrcaCloudEnvironmentBuildEvent['event']): void => {
          if (sender.isDestroyed()) {
            stopWatch(watchId)
            return
          }
          const payload: OrcaCloudEnvironmentBuildEvent = {
            watchId,
            envId: id.data,
            buildId: bid.data,
            event: streamEvent
          }
          sender.send(ORCA_CLOUD_ENVIRONMENT_BUILD_EVENT_CHANNEL, payload)
        }
        const watch = watchHostedEnvironmentBuild({
          client,
          envId: id.data,
          buildId: bid.data,
          onEvent: send
        })
        watches.set(watchId, { senderId: sender.id, stop: watch.stop, notify: send })
        void watch.done.finally(() => {
          if (watches.get(watchId)?.stop === watch.stop) {
            watches.delete(watchId)
          }
        })
        return { watchId }
      })
    }
  )

  ipcMain.handle('orcaCloudEnvironments:unwatchBuild', (event, watchId: unknown) => {
    // Only the window that opened a watch may stop it.
    if (typeof watchId === 'string' && watches.get(watchId)?.senderId === event.sender.id) {
      stopWatch(watchId)
    }
  })

  ipcMain.handle('orcaCloudEnvironments:readRepoSetupImports', (_event, repoPath: unknown) =>
    hostedEnvironmentResult(() => readRepoSetupImports(repoPath, registeredLocalRepoPaths()))
  )
}
