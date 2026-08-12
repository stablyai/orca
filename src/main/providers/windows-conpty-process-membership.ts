import { fork, type ChildProcess } from 'node:child_process'

const CONPTY_PROCESS_LIST_TIMEOUT_MS = 3_000

type ProcessListMessage = { consoleProcessList?: unknown }

type WindowsConptyMembershipDeps = {
  forkProcess?: typeof fork
  resolveAgentPath?: () => string
  timeoutMs?: number
}

function resolveNodePtyConsoleListAgent(): string {
  return require.resolve('node-pty/lib/conpty_console_list_agent.js')
}

/**
 * Returns normalized console membership, or null when the probe is unavailable.
 * A root-only set proves the shell is alone because successful raw results include the helper.
 */
export function readWindowsConptyProcessIds(
  rootPid: number,
  deps: WindowsConptyMembershipDeps = {}
): Promise<ReadonlySet<number> | null> {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) {
    return Promise.resolve(null)
  }
  let child: ChildProcess
  try {
    child = (deps.forkProcess ?? fork)(
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
