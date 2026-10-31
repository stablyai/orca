// Uninstall only: end each running WSL host's terminals and orcad, so its distro can stop.
// No paired connection exists by then, so the server's own CLI inside the distro stands in for RPC.
import { z } from 'zod'
import { errorMessage } from '../../shared/error-message'
import type { WslHostServerStop } from '../../shared/wsl-host-types'
import { execCommand } from '../ssh/remote-exec/remote-exec-command'
import { listRunningWslDistrosAsync } from '../wsl'
import { readWslHostRecordsQuietly } from './wsl-host-connection-record'
import {
  decommissionWslHostOrcad,
  stopWslHostServer,
  type WslHostTerminalLeftover
} from './wsl-host-server-stop'
import { defaultWslOrcadEnvironmentId } from './wsl-orcad-deploy'
import { createWslOrcadHostTransport } from './wsl-orcad-host-transport'
import type { WslOrcadHostTarget } from './wsl-orcad-host-target'

/** Per distro; the uninstaller waits on the whole preflight. */
export const WSL_HOST_UNINSTALL_STOP_TIMEOUT_MS = 15_000

/** orcad writes this launcher into its data root; older slots without a CLI have none. */
const GUEST_CLI = '"$HOME/.orca/cli/bin/orca"'

const TerminalListSchema = z.object({
  result: z.object({
    terminals: z.array(z.object({ handle: z.string().min(1), worktreeId: z.string() }))
  })
})
const StatusSchema = z.object({
  result: z.object({ runtime: z.object({ runtimeId: z.string().min(1).optional() }) })
})

/** The CLI's JSON envelope, past anything a login shell printed first. */
function parseCliJson(stdout: string): unknown {
  const start = stdout.indexOf('{')
  if (start === -1) {
    throw new Error(`no JSON from the server's CLI: ${stdout.slice(0, 200)}`)
  }
  return JSON.parse(stdout.slice(start))
}

/** Remove host's teardown, driven through the in-distro CLI; the census is the CLI's terminal list. */
export async function stopWslHostServerFromGuest(
  distro: string,
  signal: AbortSignal
): Promise<WslHostServerStop> {
  const target: WslOrcadHostTarget = {
    kind: 'wsl',
    id: defaultWslOrcadEnvironmentId(distro),
    distro,
    label: distro
  }
  const transport = createWslOrcadHostTransport({ target, commandLoops: false })
  const cli = async (args: string): Promise<unknown> =>
    parseCliJson(await execCommand(transport, `${GUEST_CLI} ${args} --json`, { signal }))
  const listTerminals = async () =>
    TerminalListSchema.parse(await cli('terminal list --limit 1000')).result.terminals
  try {
    return await stopWslHostServer({
      // Peers can't be asked without a paired connection; uninstall ends this host for everyone.
      peerDesktops: async () => ({ kind: 'none' }),
      endTerminals: async () => {
        const leftovers: WslHostTerminalLeftover[] = []
        for (const terminal of await listTerminals()) {
          try {
            await cli(`terminal close --terminal '${terminal.handle.replace(/'/g, '')}'`)
          } catch (error) {
            leftovers.push({ ...terminal, reason: errorMessage(error) })
          }
        }
        return leftovers
      },
      census: async () => {
        const live = await listTerminals().catch(() => null)
        return {
          liveSessions: live ? live.length : null,
          startedSinceActivation: null,
          daemonProtocolVersion: null
        }
      },
      servingRuntimeId: async () =>
        StatusSchema.parse(await cli('status')).result.runtime.runtimeId ?? null,
      closeBridge: async () => {},
      decommission: decommissionWslHostOrcad(target, transport)
    })
  } finally {
    transport.dispose()
  }
}

export type WslHostUninstallStopDependencies = {
  distros: () => string[]
  /** Confirmed running list; null when it can't be read. Must never start a distro. */
  listRunning: () => Promise<string[] | null>
  stop: (distro: string, signal: AbortSignal) => Promise<WslHostServerStop>
  timeoutMs?: number
}

export function wslHostUninstallStopDependencies(
  userDataPath: string
): WslHostUninstallStopDependencies {
  return {
    distros: () => readWslHostRecordsQuietly(userDataPath).map((record) => record.distro),
    listRunning: () => listRunningWslDistrosAsync({ requireConfirmed: true }).catch(() => null),
    stop: stopWslHostServerFromGuest
  }
}

async function stopWithin(
  distro: string,
  deps: WslHostUninstallStopDependencies
): Promise<WslHostServerStop> {
  const controller = new AbortController()
  const timeoutMs = deps.timeoutMs ?? WSL_HOST_UNINSTALL_STOP_TIMEOUT_MS
  let timer: NodeJS.Timeout | undefined
  const timedOut = new Promise<WslHostServerStop>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve({
        stopped: false,
        verdict: 'unverifiable',
        reason: `timed out after ${timeoutMs} ms`
      })
    }, timeoutMs)
  })
  try {
    return await Promise.race([
      deps.stop(distro, controller.signal).catch((error: unknown): WslHostServerStop => ({
        stopped: false,
        verdict: 'unverifiable',
        reason: errorMessage(error)
      })),
      timedOut
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Best effort and bounded: a stopped or unconfirmed distro is skipped, never booted. */
export async function stopWslHostServersForUninstall(
  deps: WslHostUninstallStopDependencies
): Promise<void> {
  const distros = [...new Map(deps.distros().map((d) => [d.toLowerCase(), d])).values()]
  if (distros.length === 0) {
    return
  }
  const running = await deps.listRunning()
  if (running === null) {
    console.warn('[wsl] uninstall left WSL host servers alone: the running list was unreadable')
    return
  }
  const isRunning = new Set(running.map((d) => d.toLowerCase()))
  await Promise.all(
    distros.map(async (distro) => {
      if (!isRunning.has(distro.toLowerCase())) {
        console.log(`[wsl] uninstall skipped the ${distro} host server: the distro is stopped`)
        return
      }
      const result = await stopWithin(distro, deps)
      console.log(
        result.stopped
          ? `[wsl] uninstall stopped the ${distro} host server`
          : `[wsl] uninstall could not stop the ${distro} host server: ${result.reason}`
      )
    })
  )
}
