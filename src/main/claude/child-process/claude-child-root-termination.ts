import { signalProviderRoot, type ProviderChild } from '../../provider-process/provider-child'

type RootTerminationInput = {
  child: Pick<ProviderChild, 'kill' | 'signalRoot'>
  exited: () => boolean
}

/** Use Node's retained handle so unreadable tables cannot block root termination or target a recycled PID. */
export async function terminateClaudeRoot(input: RootTerminationInput): Promise<boolean> {
  return input.exited() ? false : signalProviderRoot(input.child, 'SIGKILL')
}
