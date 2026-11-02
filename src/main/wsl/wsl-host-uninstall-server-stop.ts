// Uninstall only: end each running WSL host's terminals and orcad, so its distro can stop.
// No paired connection exists by then, so the server's own CLI inside the distro stands in for RPC.
import { z } from 'zod'
import { errorMessage } from '../../shared/error-message'
import { quotePosixShell } from '../../shared/shell-argument-quoting'
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

/** Per distro; the uninstaller waits on the whole preflight. The guest steps below are a fixed
 * handful of wsl.exe calls whatever the terminal count, leaving most of this for decommission. */
export const WSL_HOST_UNINSTALL_STOP_TIMEOUT_MS = 30_000

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

// Each guest CLI call is bounded so one that hangs can't spend the whole budget.
function guestPrelude(callSeconds: number): string {
  return `cli=${GUEST_CLI}; t=; command -v timeout >/dev/null 2>&1 && t='timeout ${callSeconds}';`
}
// The census waits at most this long overall, plus one bounded call: about 12 s of the 30.
const CENSUS_DEADLINE_SECONDS = 8
const CENSUS_CALL_SECONDS = 4

type GuestTerminal = { handle: string; worktreeId: string }

/** One wsl.exe call closes every worktree's terminals in parallel; returns those that refused. */
export function buildCloseTerminalsCommand(worktreeIds: readonly string[]): string {
  const closes = worktreeIds.map(
    (id, index) =>
      `( $t "$cli" terminal close --worktree ${quotePosixShell(`id:${id}`)} --all --json >/dev/null 2>&1; echo "UNINSTALL_CLOSE ${index} $?" ) &`
  )
  return `${guestPrelude(8)} ${closes.join(' ')} wait`
}

/** One wsl.exe call that waits in the guest, up to an overall deadline, for the terminal list to
 * empty; a list the CLI couldn't produce is unknown, never zero. */
export function buildCensusCommand(deadlineSeconds = CENSUS_DEADLINE_SECONDS): string {
  return (
    `${guestPrelude(CENSUS_CALL_SECONDS)} end=$(($(date +%s) + ${deadlineSeconds})); ` +
    `while :; do out=$($t "$cli" terminal list --limit 1000 --json) || { echo UNINSTALL_CENSUS unknown; exit 0; }; ` +
    `n=$(($(printf '%s' "$out" | grep -o '"handle"' | wc -l))); ` +
    `{ [ "$n" -eq 0 ] || [ "$(date +%s)" -ge "$end" ]; } && break; sleep 0.5; done; echo "UNINSTALL_CENSUS $n"`
  )
}

function closeLeftovers(
  terminals: readonly GuestTerminal[],
  stdout: string
): WslHostTerminalLeftover[] {
  const worktreeIds = [...new Set(terminals.map((terminal) => terminal.worktreeId))]
  const exits = new Map<number, string>()
  for (const match of stdout.matchAll(/^UNINSTALL_CLOSE (\d+) (\d+)$/gm)) {
    exits.set(Number(match[1]), match[2])
  }
  return worktreeIds.flatMap((id, index) => {
    const code = exits.get(index)
    if (code === '0') {
      return []
    }
    const reason = code === undefined ? 'the close did not answer' : `the close exited ${code}`
    return terminals.filter((t) => t.worktreeId === id).map((t) => ({ ...t, reason }))
  })
}

function parseCensus(stdout: string): number | null {
  const match = /^UNINSTALL_CENSUS (\d+|unknown)$/m.exec(stdout)
  return match && match[1] !== 'unknown' ? Number(match[1]) : null
}

/** Remove host's teardown, driven through the in-distro CLI in a fixed number of wsl.exe calls. */
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
  // The signal also ends decommission's own wsl.exe calls once the budget runs out.
  const transport = createWslOrcadHostTransport({ target, commandLoops: false, signal })
  const run = (command: string): Promise<string> => execCommand(transport, command, { signal })
  const cli = async (args: string): Promise<unknown> =>
    parseCliJson(await run(`${GUEST_CLI} ${args} --json`))
  try {
    return await stopWslHostServer({
      // Peers can't be asked without a paired connection; uninstall ends this host for everyone.
      peerDesktops: async () => ({ kind: 'none' }),
      endTerminals: async () => {
        const terminals = TerminalListSchema.parse(await cli('terminal list --limit 1000')).result
          .terminals
        if (terminals.length === 0) {
          return []
        }
        const worktreeIds = [...new Set(terminals.map((terminal) => terminal.worktreeId))]
        return closeLeftovers(terminals, await run(buildCloseTerminalsCommand(worktreeIds)))
      },
      census: async () => ({
        liveSessions: parseCensus(await run(buildCensusCommand()).catch(() => '')),
        startedSinceActivation: null,
        daemonProtocolVersion: null
      }),
      censusAttempts: 1,
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

// After the abort, late steps get this long to unwind before the holder release.
const ABORT_SETTLE_MS = 2_000

async function stopWithin(
  distro: string,
  deps: WslHostUninstallStopDependencies
): Promise<WslHostServerStop> {
  const controller = new AbortController()
  const timeoutMs = deps.timeoutMs ?? WSL_HOST_UNINSTALL_STOP_TIMEOUT_MS
  const stopping = deps
    .stop(distro, controller.signal)
    .catch((error: unknown): WslHostServerStop => ({
      stopped: false,
      verdict: 'unverifiable',
      reason: errorMessage(error)
    }))
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
  })
  const first = await Promise.race([stopping, deadline])
  clearTimeout(timer)
  if (first !== 'timeout') {
    return first
  }
  // Aborting refuses new wsl.exe calls and ends running ones; wait for them before the holder goes.
  controller.abort()
  await Promise.race([stopping, new Promise((resolve) => setTimeout(resolve, ABORT_SETTLE_MS))])
  return { stopped: false, verdict: 'unverifiable', reason: `timed out after ${timeoutMs} ms` }
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
