import type { ChildProcess } from 'node:child_process'
import { forkProcess } from '../../shared/child-process/fork-process'
import { resolveWindowsBunPtyGateEntry } from '../daemon/pty-subprocess/windows-bun-pty-launch'
import { WINDOWS_BUN_CONSOLE_LIST_ARGUMENT } from './windows-bun-console-process-list'

const CONPTY_PROCESS_LIST_TIMEOUT_MS = 3_000

type ProcessListMessage = { consoleProcessList?: unknown }

type WindowsConsoleAttachedProcessDeps = {
  forkProcess?: (modulePath: string, args: string[]) => ChildProcess
  resolveAgentPath?: () => string
  timeoutMs?: number
}

function resolveConsoleListAgent(): string {
  return process.versions.bun
    ? resolveWindowsBunPtyGateEntry()
    : require.resolve('node-pty/lib/conpty_console_list_agent.js')
}

function spawnConsoleListAgent(modulePath: string, args: string[]): ChildProcess {
  return forkProcess({ modulePath, args, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
}

/**
 * Processes ATTACHED TO THIS PANE'S CONSOLE, or null when unavailable.
 *
 * Distinct from job membership on purpose. `GetConsoleProcessList` must be
 * called from a process attached to that console, and a process can hold only
 * one console at a time -- which is why node-pty answers it from a separate
 * process, and why this still forks.
 *
 * Only the candidate FILTER may use this. That filter exists to drop a
 * descendant which detached from the console (`Start-Process`, a GUI child), and
 * the job object deliberately still contains those, so the job cannot answer it
 * -- see docs/windows-wsl-root-cause-plan.html, "Use B".
 *
 * This is not the fork storm in #10857: it runs only when a recognized agent
 * candidate already exists, not on every foreground poll. Bounding it to one
 * pooled, supervised helper is the remaining half of that fix.
 */
export function readWindowsConsoleAttachedProcessIds(
  rootPid: number,
  deps: WindowsConsoleAttachedProcessDeps = {}
): Promise<ReadonlySet<number> | null> {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0 || rootPid >= 0xffff_ffff) {
    return Promise.resolve(null)
  }
  let child: ChildProcess
  try {
    child = (deps.forkProcess ?? spawnConsoleListAgent)(
      (deps.resolveAgentPath ?? resolveConsoleListAgent)(),
      process.versions.bun
        ? [WINDOWS_BUN_CONSOLE_LIST_ARGUMENT, String(rootPid)]
        : [String(rootPid)]
    )
  } catch {
    return Promise.resolve(null)
  }

  return new Promise((resolve) => {
    let settled = false
    const finish = (value: ReadonlySet<number> | null): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      child.removeListener('message', onMessage)
      // Why: kill failures can emit asynchronously after timeout settlement;
      // teardown listeners stay until exit so they cannot crash the daemon.
      resolve(value)
    }
    const onFailure = (): void => finish(null)
    const onExit = (): void => {
      child.removeListener('error', onFailure)
      finish(null)
    }
    const onMessage = (message: ProcessListMessage): void => {
      const value = message?.consoleProcessList
      const helperPid = child.pid
      if (
        !Array.isArray(value) ||
        helperPid === undefined ||
        !value.includes(rootPid) ||
        !value.includes(helperPid) ||
        value.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)
      ) {
        finish(null)
        return
      }
      // Why: GetConsoleProcessList includes this helper; removing it makes a
      // root-only set authoritative shell-only evidence instead of a false child.
      const consoleProcessIds = new Set(value)
      consoleProcessIds.delete(helperPid)
      finish(consoleProcessIds)
    }
    const timeout = setTimeout(() => {
      child.kill()
      finish(null)
    }, deps.timeoutMs ?? CONPTY_PROCESS_LIST_TIMEOUT_MS)
    child.once('message', onMessage)
    child.once('error', onFailure)
    child.once('exit', onExit)
  })
}
