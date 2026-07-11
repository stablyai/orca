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
 * Runs node-pty's fixed native console-list helper with bounded error/exit
 * handling. A root-only result is its failure fallback, not shell proof.
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
      child.removeListener('error', onFailure)
      child.removeListener('exit', onFailure)
      resolve(value)
    }
    const onFailure = (): void => finish(null)
    const onMessage = (message: ProcessListMessage): void => {
      const value = message?.consoleProcessList
      if (
        !Array.isArray(value) ||
        value.length <= 1 ||
        !value.includes(rootPid) ||
        value.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)
      ) {
        finish(null)
        return
      }
      finish(new Set(value))
    }
    const timeout = setTimeout(() => {
      child.kill()
      finish(null)
    }, deps.timeoutMs ?? CONPTY_PROCESS_LIST_TIMEOUT_MS)
    child.once('message', onMessage)
    child.once('error', onFailure)
    child.once('exit', onFailure)
  })
}
