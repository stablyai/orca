import { forkProcess } from '@orca/process-host/fork-process'
import type { SpawnedProcess } from '@orca/process-host/process-spec'

const CONPTY_PROCESS_LIST_TIMEOUT_MS = 3_000

type ProcessListMessage = { consoleProcessList?: unknown }

type ForkConsoleListAgent = (
  modulePath: string,
  args: string[],
  options: { silent: true }
) => SpawnedProcess

const forkConsoleListAgent: ForkConsoleListAgent = (modulePath, args) =>
  forkProcess({ modulePath, args, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] })

type WindowsConsoleAttachedProcessDeps = {
  forkProcess?: ForkConsoleListAgent
  resolveAgentPath?: () => string
  timeoutMs?: number
}

function resolveNodePtyConsoleListAgent(): string {
  return require.resolve('node-pty/lib/conpty_console_list_agent.js')
}

/** GetConsoleProcessList needs an attached helper because one process can own only one console.
 * Use for agent filtering/adoption that excludes detached members; job polling cannot distinguish those (#10857). */
export function readWindowsConsoleAttachedProcessIds(
  rootPid: number,
  deps: WindowsConsoleAttachedProcessDeps = {}
): Promise<ReadonlySet<number> | null> {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) {
    return Promise.resolve(null)
  }
  let child: SpawnedProcess
  try {
    child = (deps.forkProcess ?? forkConsoleListAgent)(
      (deps.resolveAgentPath ?? resolveNodePtyConsoleListAgent)(),
      [String(rootPid)],
      { silent: true }
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
      // Kill errors may arrive after timeout settlement; retain teardown listeners until exit.
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
      // Exclude the helper so a root-only console can prove shell-only ownership.
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
