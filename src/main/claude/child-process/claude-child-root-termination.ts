import type { ProviderChild } from '../../provider-process/provider-child'

type RootTerminationInput = {
  child: Pick<ProviderChild, 'kill'>
  exited: () => boolean
}

/** Use Node's retained handle so unreadable tables cannot block root termination or target a recycled PID. */
export function terminateClaudeRoot(input: RootTerminationInput): boolean {
  return input.exited() ? false : input.child.kill('SIGKILL')
}
