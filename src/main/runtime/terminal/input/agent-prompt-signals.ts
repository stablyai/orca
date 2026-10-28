import type { RuntimeAgentPromptWriteOptions } from '../../runtime-terminal-contracts'

export function agentPromptObservationSignal(
  options: RuntimeAgentPromptWriteOptions
): AbortSignal | undefined {
  return options.signal && options.observationSignal
    ? AbortSignal.any([options.signal, options.observationSignal])
    : (options.signal ?? options.observationSignal)
}
