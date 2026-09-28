import { bunOwnedRuntimeArgs } from '../../shared/bun-owned-runtime-args'
import type { ChildProcess } from 'node:child_process'
import { spawnProcess } from '../../shared/child-process/run-process'
import { resolveWindowsBunPtyGateEntry } from '../daemon/pty-subprocess/windows-bun-pty-launch'
import { WINDOWS_BUN_CONSOLE_LIST_ARGUMENT } from './windows-bun-console-process-list'

import { acquireWindowsConsoleRuntime } from './windows-console-runtime'

const CONPTY_PROCESS_LIST_TIMEOUT_MS = 3_000

type ProcessListMessage = { consoleProcessList?: unknown }

type WindowsConsoleAttachedProcessDeps = {
  forkProcess?: (modulePath: string, args: string[]) => ChildProcess
  resolveAgentPath?: () => string
  timeoutMs?: number
}

function spawnConsoleListAgent(execPath: string, modulePath: string, args: string[]): ChildProcess {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  delete env.NODE_PATH
  delete env.BUN_OPTIONS
  return spawnProcess({
    program: execPath,
    args: [...bunOwnedRuntimeArgs('win32'), modulePath, ...args],
    env,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc']
  })
}

/**
 * Processes ATTACHED TO THIS PANE'S CONSOLE, or null when unavailable.
 *
 * Distinct from job membership on purpose. `GetConsoleProcessList` must be
 * called from a process attached to that console, and a process can hold only
 * one console at a time -- so the Bun gate answers it in a separate
 * process without changing the caller's console.
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
export async function readWindowsConsoleAttachedProcessIds(
  rootPid: number,
  deps: WindowsConsoleAttachedProcessDeps = {}
): Promise<ReadonlySet<number> | null> {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0 || rootPid >= 0xffff_ffff) {
    return null
  }
  const deadline = Date.now() + (deps.timeoutMs ?? CONPTY_PROCESS_LIST_TIMEOUT_MS)
  let child: ChildProcess
  let runtime: Awaited<ReturnType<typeof acquireWindowsConsoleRuntime>> = null
  try {
    const args = [WINDOWS_BUN_CONSOLE_LIST_ARGUMENT, String(rootPid)]
    if (deps.forkProcess) {
      child = deps.forkProcess((deps.resolveAgentPath ?? resolveWindowsBunPtyGateEntry)(), args)
    } else {
      runtime = await acquireWindowsConsoleRuntime(deadline - Date.now())
      if (!runtime || Date.now() >= deadline) {
        return null
      }
      child = spawnConsoleListAgent(runtime.execPath, runtime.entryPath, args)
    }
  } catch {
    runtime?.invalidate()
    return null
  } finally {
    // A spawned helper is now protected by the process-table retention check.
    runtime?.release()
  }

  return new Promise((resolve) => {
    let settled = false
    const finish = (value: ReadonlySet<number> | null): void => {
      if (settled) {
        return
      }
      settled = true
      if (value === null) {
        runtime?.invalidate()
      }
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
    const timeout = setTimeout(
      () => {
        try {
          child.kill()
        } catch {
          // A failed kill leaves console ownership unknown.
        }
        finish(null)
      },
      Math.max(1, deadline - Date.now())
    )
    child.once('message', onMessage)
    child.once('error', onFailure)
    child.once('exit', onExit)
  })
}
