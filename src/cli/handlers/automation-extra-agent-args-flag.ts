import { RuntimeClientError } from '../runtime-client'

/** Returns the text unchanged; an explicit empty value clears saved extras on edit. */
export function getExtraAgentArgsFlag(flags: Map<string, string | boolean>): string | undefined {
  if (!flags.has('extra-agent-args')) {
    return undefined
  }
  const value = flags.get('extra-agent-args')
  if (typeof value !== 'string') {
    throw new RuntimeClientError(
      'invalid_argument',
      '--extra-agent-args requires a value; use --extra-agent-args="--model opus --effort high", or --extra-agent-args= to clear'
    )
  }
  return value
}
