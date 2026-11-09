import type { ChildProcess } from 'node:child_process'

type RootTerminationInput = {
  child: Pick<ChildProcess, 'kill'>
  exited: () => boolean
}

/** Use Node's retained handle so unreadable tables cannot block root termination or target a recycled PID. */
export function terminateClaudeRoot(input: RootTerminationInput): boolean {
  return input.exited() ? false : input.child.kill('SIGKILL')
}
