import type { AgentProcessIdentity } from '../../shared/agent-process-presence'
import type { PtyIncarnationId } from '../../shared/pty-incarnation'
import type { TerminalAgent } from '../../shared/terminal-agent'
import { withTimeout } from '../../shared/promise-timeout-fallback'
import { chatAgentsShareConversations } from '../../shared/structured-agent-cli-conversation-adoption'
import {
  recognizeAgentProcess,
  recognizeAgentProcessFromCommandLine
} from '../../shared/agent-process-recognition'
import { isShellProcess } from '../../shared/shell-process-detection'
import {
  buildProcessTableIndex,
  collectDescendantsFromIndex
} from '../../shared/process-table-index'
import { resolveWindowsForegroundIdentity } from '../providers/windows-agent-foreground-process'
import { readWindowsConsoleAttachedProcessIds } from '../providers/windows-console-attached-processes'
import {
  isWindowsProcessStartTimeAvailable,
  readWindowsProcessCreationTime,
  readWindowsProcessTableFresh,
  type WindowsProcessRow
} from '../windows/windows-process-table'

type Identity = { pid: number; startTime: string }
type Target = Identity & { depth: number }
export type WindowsPaneAgentStopDeps = {
  readRows: () => Promise<WindowsProcessRow[]>
  readCreationTime: (pid: number) => number | null
  readConsole: (pid: number) => Promise<ReadonlySet<number> | null>
  kill: (pid: number) => void
}
const nativeDeps: WindowsPaneAgentStopDeps = {
  readRows: readWindowsProcessTableFresh,
  readCreationTime: readWindowsProcessCreationTime,
  readConsole: readWindowsConsoleAttachedProcessIds,
  kill: (pid) => {
    process.kill(pid, 'SIGKILL')
  }
}
export type WindowsPaneAgentStopCapture = {
  root: Identity
  shell: Identity
  agent: Identity | null
  paused: false
  refusal?: 'agentAmbiguous' | 'shellReplaced'
  targets: Target[]
  deps: WindowsPaneAgentStopDeps
}
const identity = (row: WindowsProcessRow): Identity => {
  if (!Number.isSafeInteger(row.creationTimeMs) || !row.creationTimeMs || row.pid <= 1) {
    throw new Error('process identity unavailable')
  }
  return { pid: row.pid, startTime: String(row.creationTimeMs) }
}
const same = (row: WindowsProcessRow | undefined, target: Identity): boolean =>
  row !== undefined && row.pid === target.pid && String(row.creationTimeMs) === target.startTime
const recognize = (row: WindowsProcessRow) =>
  recognizeAgentProcessFromCommandLine(row.command) ??
  recognizeAgentProcessFromCommandLine(row.name)

async function bounded<T>(pending: Promise<T>, deadline: number): Promise<T> {
  const timeout = Symbol('process deadline')
  const result = await withTimeout<T | typeof timeout>(
    pending,
    Math.max(0, deadline - Date.now()),
    timeout
  )
  if (result === timeout) {
    throw new Error('process deadline')
  }
  return result
}

function paneRows(rows: WindowsProcessRow[], root: Identity) {
  const index = buildProcessTableIndex(rows)
  if (index.byPid.size !== rows.length || !same(index.byPid.get(root.pid), root)) {
    throw new Error('pane root changed')
  }
  const children = collectDescendantsFromIndex(index, root.pid)
  for (const child of children) {
    const parent = index.byPid.get(child.ppid)
    if (!parent || Number(identity(parent).startTime) > Number(identity(child).startTime)) {
      throw new Error('parent identity unproven')
    }
  }
  return { index, children }
}

export function windowsPaneAgentStopAvailable(): boolean {
  return (
    process.platform === 'win32' &&
    isWindowsProcessStartTimeAvailable() &&
    readWindowsProcessCreationTime(process.pid) !== null
  )
}

export async function captureWindowsPaneAgentStop(
  input: {
    rootPid: number
    agent: TerminalAgent
    hookProcess?: AgentProcessIdentity
    ptyId: string
    incarnationId: PtyIncarnationId
  },
  deps: WindowsPaneAgentStopDeps = nativeDeps
): Promise<WindowsPaneAgentStopCapture | null> {
  try {
    const deadline = Date.now() + 3_000
    const rows = await bounded(deps.readRows(), deadline)
    const rootRow = rows.find((row) => row.pid === input.rootPid)
    if (!rootRow) {
      return null
    }
    const root = identity(rootRow)
    const { children, index } = paneRows(rows, root)
    const shells = isShellProcess(rootRow.name)
      ? [rootRow]
      : children.filter((row) => row.ppid === root.pid && isShellProcess(row.name))
    const shell = shells.length === 1 ? shells[0] : null
    const capture: WindowsPaneAgentStopCapture = {
      root,
      shell: shell ? identity(shell) : root,
      agent: null,
      paused: false,
      targets: [],
      deps
    }
    if (recognize(rootRow)) {
      return { ...capture, refusal: 'shellReplaced' }
    }
    if (!shell) {
      return null
    }
    const candidates = collectDescendantsFromIndex(index, shell.pid).map((row) => ({
      ...row,
      command: row.command || row.name
    }))
    if (!candidates.some(recognize)) {
      return capture
    }
    const selected = resolveWindowsForegroundIdentity(candidates, shell.name, undefined)
    const recognized = recognizeAgentProcess(selected.processName)
    if (
      !selected.processId ||
      !recognized ||
      !chatAgentsShareConversations(recognized.agent, input.agent)
    ) {
      return { ...capture, refusal: 'agentAmbiguous' }
    }
    const agent = index.byPid.get(selected.processId)
    if (!agent) {
      return null
    }
    const consolePids = await bounded(deps.readConsole(shell.pid), deadline)
    if (!consolePids?.has(agent.pid)) {
      return null
    }
    capture.agent = identity(agent)
    if (
      input.hookProcess &&
      (input.hookProcess.platform !== 'win32' ||
        input.hookProcess.pid !== agent.pid ||
        input.hookProcess.startTime !== capture.agent.startTime)
    ) {
      return null
    }
    capture.targets = [
      { ...capture.agent, depth: 0 },
      ...collectDescendantsFromIndex(index, agent.pid).map((row) => ({
        ...identity(row),
        depth: row.depth
      }))
    ]
    if (
      capture.targets.some(
        (target) =>
          target.pid === root.pid ||
          target.pid === shell.pid ||
          index.byPid.get(target.pid)?.name.toLowerCase() === 'conhost.exe'
      )
    ) {
      return null
    }
    return capture
  } catch {
    return null
  }
}

export async function windowsPaneAgentStopReleased(
  capture: WindowsPaneAgentStopCapture,
  predict = false
): Promise<boolean> {
  try {
    if (capture.refusal) {
      return false
    }
    const rows = await capture.deps.readRows()
    const { index, children } = paneRows(rows, capture.root)
    if (!same(index.byPid.get(capture.shell.pid), capture.shell)) {
      return false
    }
    return children.every(
      (row) => !recognize(row) || (predict && capture.targets.some((target) => same(row, target)))
    )
  } catch {
    return false
  }
}

export async function stopWindowsPaneAgentAndWait(
  capture: WindowsPaneAgentStopCapture,
  ownsPane: () => boolean
): Promise<'exited' | 'unproven'> {
  const deadline = Date.now() + 5_000
  try {
    if (
      capture.refusal ||
      !ownsPane() ||
      !(await bounded(windowsPaneAgentStopReleased(capture, true), deadline))
    ) {
      return 'unproven'
    }
    const targets = new Map(capture.targets.map((target) => [target.pid, target]))
    const signaled = new Set<number>()
    let absences = 0
    while (Date.now() < deadline) {
      const rows = await bounded(capture.deps.readRows(), deadline)
      const { index, children } = paneRows(rows, capture.root)
      if (!ownsPane() || !same(index.byPid.get(capture.shell.pid), capture.shell)) {
        return 'unproven'
      }
      // Retain children before reparenting; escaped detached children are outside the ancestry model.
      for (const target of targets.values()) {
        if (!same(index.byPid.get(target.pid), target)) {
          continue
        }
        for (const child of collectDescendantsFromIndex(index, target.pid)) {
          const parent = index.byPid.get(child.ppid)
          if (!parent || Number(identity(parent).startTime) > Number(identity(child).startTime)) {
            return 'unproven'
          }
          const value = { ...identity(child), depth: target.depth + child.depth }
          const previous = targets.get(child.pid)
          if (previous && previous.startTime !== value.startTime) {
            return 'unproven'
          }
          if (
            child.pid === capture.root.pid ||
            child.pid === capture.shell.pid ||
            child.name.toLowerCase() === 'conhost.exe'
          ) {
            return 'unproven'
          }
          targets.set(child.pid, value)
        }
      }
      if (
        children.some(
          (row) => recognize(row) && !same(row, targets.get(row.pid) ?? { pid: -1, startTime: '' })
        )
      ) {
        return 'unproven'
      }
      const live = [...targets.values()].filter((target) =>
        same(index.byPid.get(target.pid), target)
      )
      if (live.length === 0) {
        if (
          ++absences >= 2 &&
          (await bounded(windowsPaneAgentStopReleased(capture), deadline)) &&
          ownsPane()
        ) {
          return 'exited'
        }
      } else {
        absences = 0
      }
      for (const target of live.sort((a, b) => b.depth - a.depth)) {
        if (signaled.has(target.pid)) {
          continue
        }
        if (
          !ownsPane() ||
          capture.deps.readCreationTime(capture.root.pid) !== Number(capture.root.startTime) ||
          capture.deps.readCreationTime(capture.shell.pid) !== Number(capture.shell.startTime)
        ) {
          return 'unproven'
        }
        // Like POSIX, a fresh birth check narrows but cannot eliminate the check-to-kill PID-reuse race.
        if (capture.deps.readCreationTime(target.pid) !== Number(target.startTime)) {
          continue
        }
        try {
          capture.deps.kill(target.pid)
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
            return 'unproven'
          }
        }
        signaled.add(target.pid)
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  } catch {
    return 'unproven'
  }
  return 'unproven'
}
