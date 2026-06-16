import { ipcMain, type BrowserWindow } from 'electron'
import type { Store } from '../persistence'
import type { SshTarget } from '../../shared/ssh-types'
import {
  LOCAL_DOCKER_CONNECTION,
  type DockerConnection,
  type DockerConnectionStatus,
  type DockerContainerAction,
  type DockerResourceKind,
  type DockerSshTargetRef
} from '../../shared/docker-types'
import {
  listContainers,
  inspectContainer,
  runContainerAction,
  listImages,
  listVolumes,
  listNetworks,
  runResourceRemove,
  runResourcePrune,
  DockerCommandError
} from '../docker/docker-command-runner'

const DOCKER_IPC_CHANNELS = [
  'docker:listContainers',
  'docker:pingConnection',
  'docker:inspect',
  'docker:containerAction',
  'docker:listImages',
  'docker:listVolumes',
  'docker:listNetworks',
  'docker:resourceRemove',
  'docker:resourcePrune'
] as const
const POLL_INTERVAL_MS = 3_000

let currentGetMainWindow: (() => BrowserWindow | null) | null = null
let getSshTargetById: ((id: string) => SshTarget | undefined) | null = null
let pollTimer: NodeJS.Timeout | null = null
// Foundation tracks a single active connection; multi-connection polling is out of scope here.
let activeConnectionId = LOCAL_DOCKER_CONNECTION.id
let polling = false

function resolveConnection(store: Store, connectionId: string): DockerConnection {
  if (connectionId === LOCAL_DOCKER_CONNECTION.id) {
    return LOCAL_DOCKER_CONNECTION
  }
  const found = store.getSettings().dockerConnections?.find((c) => c.id === connectionId)
  if (!found) {
    throw new Error(`Unknown Docker connection: ${connectionId}`)
  }
  return found
}

function resolveSshTarget(conn: DockerConnection): DockerSshTargetRef | undefined {
  if (conn.kind !== 'ssh' || !conn.sshTargetId) {
    return undefined
  }
  // Why: ssh path is wired defensively here; LOCAL is always used at runtime in
  // this foundation so this branch is never exercised yet.
  const target = getSshTargetById?.(conn.sshTargetId)
  return target ? { host: target.host, port: target.port, username: target.username } : undefined
}

function broadcastResources(connectionId: string, containers: unknown): void {
  const win = currentGetMainWindow?.()
  if (win && !win.isDestroyed()) {
    win.webContents.send('docker:resources-changed', { connectionId, containers })
  }
}

async function pollOnce(store: Store): Promise<void> {
  if (polling) {
    return // no-overlap guard: a slow remote `docker ps` must not stack
  }
  polling = true
  try {
    const conn = resolveConnection(store, activeConnectionId)
    const containers = await listContainers(conn, { sshTarget: resolveSshTarget(conn) })
    broadcastResources(conn.id, containers)
  } catch {
    // Errors surface through the explicit list/ping handlers; the poller stays quiet.
  } finally {
    polling = false
  }
}

export function registerDockerHandlers(
  store: Store,
  getMainWindow: () => BrowserWindow | null,
  getSshTarget: (id: string) => SshTarget | undefined
): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  polling = false

  for (const channel of DOCKER_IPC_CHANNELS) {
    ipcMain.removeHandler(channel) // re-registration safety (mirrors ssh.ts)
  }
  currentGetMainWindow = getMainWindow
  getSshTargetById = getSshTarget

  ipcMain.handle(
    'docker:inspect',
    async (_event, args: { connectionId: string; containerId: string }) => {
      const conn = resolveConnection(store, args.connectionId)
      return inspectContainer(conn, args.containerId, { sshTarget: resolveSshTarget(conn) })
    }
  )

  ipcMain.handle(
    'docker:containerAction',
    async (
      _event,
      args: { connectionId: string; containerId: string; action: DockerContainerAction }
    ) => {
      const conn = resolveConnection(store, args.connectionId)
      await runContainerAction(conn, args.containerId, args.action, {
        sshTarget: resolveSshTarget(conn)
      })
    }
  )

  ipcMain.handle('docker:listContainers', async (_event, args: { connectionId: string }) => {
    const conn = resolveConnection(store, args.connectionId)
    return listContainers(conn, { sshTarget: resolveSshTarget(conn) })
  })

  ipcMain.handle('docker:listImages', async (_e, args: { connectionId: string }) => {
    const conn = resolveConnection(store, args.connectionId)
    return listImages(conn, { sshTarget: resolveSshTarget(conn) })
  })

  ipcMain.handle('docker:listVolumes', async (_e, args: { connectionId: string }) => {
    const conn = resolveConnection(store, args.connectionId)
    return listVolumes(conn, { sshTarget: resolveSshTarget(conn) })
  })

  ipcMain.handle('docker:listNetworks', async (_e, args: { connectionId: string }) => {
    const conn = resolveConnection(store, args.connectionId)
    return listNetworks(conn, { sshTarget: resolveSshTarget(conn) })
  })

  ipcMain.handle(
    'docker:resourceRemove',
    async (_e, args: { connectionId: string; kind: DockerResourceKind; id: string }) => {
      const conn = resolveConnection(store, args.connectionId)
      await runResourceRemove(conn, args.kind, args.id, { sshTarget: resolveSshTarget(conn) })
    }
  )

  ipcMain.handle(
    'docker:resourcePrune',
    async (_e, args: { connectionId: string; kind: DockerResourceKind }) => {
      const conn = resolveConnection(store, args.connectionId)
      await runResourcePrune(conn, args.kind, { sshTarget: resolveSshTarget(conn) })
    }
  )

  ipcMain.handle(
    'docker:pingConnection',
    async (
      _event,
      args: { connectionId: string }
    ): Promise<{ status: DockerConnectionStatus; error?: string }> => {
      const conn = resolveConnection(store, args.connectionId)
      try {
        await listContainers(conn, { sshTarget: resolveSshTarget(conn) })
        activeConnectionId = conn.id
        if (pollTimer === null) {
          // Start polling on the first reachable connection rather than at registration,
          // so we don't run `docker ps` every few seconds while the panel is closed.
          // The renderer always calls pingConnection before listing, so this always runs first.
          pollTimer = setInterval(() => void pollOnce(store), POLL_INTERVAL_MS)
        }
        return { status: 'reachable' }
      } catch (error) {
        const message = error instanceof DockerCommandError ? error.message : String(error)
        return { status: 'unreachable', error: message }
      }
    }
  )
}

/** Reset module-level state. Mirrors ssh.ts so tests and window recreation start clean. */
export function resetDockerHandlerStateForTests(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  currentGetMainWindow = null
  getSshTargetById = null
  activeConnectionId = LOCAL_DOCKER_CONNECTION.id
  polling = false
}
