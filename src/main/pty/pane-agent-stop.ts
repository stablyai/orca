import type { ProcessTableRow } from '../../shared/process-table-snapshot'
import {
  buildProcessTableIndex,
  collectDescendantsFromIndex
} from '../../shared/process-table-index'
import { recognizeAgentProcessFromCommandLine } from '../../shared/agent-process-recognition'
import type { TerminalAgent } from '../../shared/terminal-agent'
import { isShellProcess } from '../../shared/shell-process-detection'
import { paneHasNoRecognizedAgent } from './pane-agent-identity-posix'

type Identity = { pid: number; startTime: string }

export type PaneAgentStopCapture = {
  shell: Identity
  agent: Identity
  agentType: TerminalAgent
  tty: string
  agentPgid: number
  paused: boolean
}

export type PaneAgentStopDeps = {
  /** Fresh execution-host rows; failures must reject, never return an empty table. */
  readRows: () => Promise<ProcessTableRow[]>
  /** Pins PTY incarnation, pane and conversation; consent belongs in this host fence. */
  ownsPane: () => boolean
  /** A fenced turn interrupt, when needed; this never supplies exit evidence. */
  interruptReply?: () => Promise<void>
  /** Production adapters must target this identity, never the shell or a PID-only Windows tree walk. */
  signal: (target: Identity, signal: 'SIGTERM' | 'SIGCONT' | 'SIGKILL') => void
  graceMs?: number
  verifyMs?: number
}

const same = (row: ProcessTableRow | undefined, identity: Identity): boolean =>
  row?.pid === identity.pid && row.startTime === identity.startTime && !row.stat.startsWith('Z')
const ttyName = (tty: string | undefined): string => (tty ?? '').replace(/^\/dev\//, '')
const stopped = (row: ProcessTableRow): boolean => /^[Tt]/.test(row.stat)

/** Stop an exact agent lineage; the original shell and unrelated jobs survive. */
export async function stopPaneAgentAndWait(
  capture: PaneAgentStopCapture,
  deps: PaneAgentStopDeps
): Promise<'exited' | 'unproven'> {
  const deadline = Date.now() + (deps.verifyMs ?? 5_000)
  const bounded = async <T>(pending: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('stop deadline')),
            Math.max(0, deadline - Date.now())
          )
        })
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  const read = async () => {
    const rows = await bounded(deps.readRows())
    const index = buildProcessTableIndex(rows)
    const shell = index.byPid.get(capture.shell.pid)
    if (
      !deps.ownsPane() ||
      new Set(rows.map((row) => row.pid)).size !== rows.length ||
      !same(shell, capture.shell) ||
      ttyName(shell?.tty) !== ttyName(capture.tty) ||
      !shell ||
      !isShellProcess(shell.command.trim().replace(/^-/, '').split(/\s+/, 1)[0] ?? '') ||
      shell.pgid === undefined ||
      !capture.tty ||
      capture.agent.pid <= 1 ||
      capture.agent.pid === capture.shell.pid
    ) {
      throw new Error('pane identity unproven')
    }
    return { rows, index, shell }
  }
  try {
    const initial = await read()
    const agent = initial.index.byPid.get(capture.agent.pid)
    const shellTree = collectDescendantsFromIndex(initial.index, capture.shell.pid)
    if (
      !same(agent, capture.agent) ||
      !agent ||
      !shellTree.some((row) => row.pid === agent.pid) ||
      agent.pgid !== capture.agentPgid ||
      ttyName(agent.tty) !== ttyName(capture.tty) ||
      recognizeAgentProcessFromCommandLine(agent.command)?.agent !== capture.agentType ||
      !paneHasNoRecognizedAgent(
        initial.rows,
        capture.shell.pid,
        new Set([
          agent.pid,
          ...collectDescendantsFromIndex(initial.index, agent.pid).map((row) => row.pid)
        ])
      )
    ) {
      return 'unproven'
    }
    const targets = new Map<number, Identity>()
    const remember = (row: ProcessTableRow): void => {
      if (!row.startTime || row.pid === capture.shell.pid) {
        throw new Error('target identity unproven')
      }
      const previous = targets.get(row.pid)
      if (previous && previous.startTime !== row.startTime) {
        throw new Error('target pid reused')
      }
      targets.set(row.pid, { pid: row.pid, startTime: row.startTime })
    }
    remember(agent)
    collectDescendantsFromIndex(initial.index, agent.pid).forEach(remember)
    if (deps.interruptReply) {
      await bounded(deps.interruptReply())
    }
    const beganAt = Date.now()
    const termed = new Set<number>()
    const forced = new Set<number>()
    let absences = 0
    while (Date.now() < deadline) {
      const current = await read()
      // Keep descendants captured before parent exit, and discover forks while a known parent lives.
      for (const identity of targets.values()) {
        const reused = current.index.byPid.get(identity.pid)
        if (reused && reused.startTime !== identity.startTime) {
          return 'unproven'
        }
        if (same(current.index.byPid.get(identity.pid), identity)) {
          collectDescendantsFromIndex(current.index, identity.pid).forEach(remember)
        }
      }
      const live = [...targets.values()].filter((identity) =>
        same(current.index.byPid.get(identity.pid), identity)
      )
      if (live.length === 0) {
        absences += 1
        if (
          absences >= 2 &&
          current.shell.tpgid === current.shell.pgid &&
          !stopped(current.shell) &&
          paneHasNoRecognizedAgent(current.rows, capture.shell.pid) &&
          deps.ownsPane()
        ) {
          // The proof awaited: fence the shell again before returning success.
          const final = await read()
          if (
            final.shell.tpgid === final.shell.pgid &&
            !stopped(final.shell) &&
            paneHasNoRecognizedAgent(final.rows, final.shell.pid) &&
            [...targets.values()].every(
              (identity) => !same(final.index.byPid.get(identity.pid), identity)
            )
          ) {
            return 'exited'
          }
        }
      } else {
        absences = 0
      }
      for (const identity of live.toReversed()) {
        if (!deps.ownsPane()) {
          return 'unproven'
        }
        const signalExact = async (signal: 'SIGTERM' | 'SIGCONT' | 'SIGKILL') => {
          const fresh = await read()
          if (same(fresh.index.byPid.get(identity.pid), identity) && deps.ownsPane()) {
            deps.signal(identity, signal)
          }
        }
        if (!termed.has(identity.pid)) {
          await signalExact('SIGTERM')
          if (stopped(current.index.byPid.get(identity.pid)!)) {
            await signalExact('SIGCONT')
          }
          termed.add(identity.pid)
        } else if (Date.now() - beganAt >= (deps.graceMs ?? 2_000) && !forced.has(identity.pid)) {
          await signalExact('SIGKILL')
          forced.add(identity.pid)
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  } catch {
    return 'unproven'
  }
  return 'unproven'
}
