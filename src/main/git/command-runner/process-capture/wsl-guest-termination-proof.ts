import type { ChildProcess } from 'node:child_process'
import type { WslProcessGroupTermination } from './wsl-process-group-termination'

/** Root wsl.exe closure cannot prove an interrupted guest command has stopped. */
export function createWslGuestTerminationProof(group: WslProcessGroupTermination) {
  let stopping = false
  let complete!: () => void
  const terminated = new Promise<void>((resolve) => {
    complete = resolve
  })
  const observe = async (child: ChildProcess, stop: () => Promise<boolean>): Promise<boolean> => {
    stopping = true
    if (!child.pid) {
      complete()
      return true
    }
    const proved = await stop()
    if (proved) {
      complete()
    }
    return proved
  }
  return {
    terminated,
    get stopping() {
      return stopping
    },
    onChildTerminated: () => {
      if (!stopping) {
        complete()
      }
    },
    barrier: {
      ...group,
      signal: (...args: Parameters<typeof group.signal>) =>
        observe(args[0], () => group.signal(...args)),
      force: (...args: Parameters<typeof group.force>) =>
        observe(args[0], () => group.force(...args))
    }
  }
}
