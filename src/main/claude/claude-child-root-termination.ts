import type { SpawnedProcess } from '@orca/process-host/process-spec'

type RootTerminationInput = {
  child: Pick<SpawnedProcess, 'kill'>
  exited: () => boolean
}

/** Use Node's retained handle so unreadable tables cannot block root termination or target a recycled PID. */
export function terminateClaudeRoot(input: RootTerminationInput): boolean {
  return input.exited() ? false : input.child.kill('SIGKILL')
}
