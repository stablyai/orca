import type { AgentSessionOptionResult } from '../../../shared/agent-session-wire'

/** A same-build caller in this process reads as the RPC gate treats one: it takes no model. */
export const IN_PROCESS_OPTIONS_READER = {
  readsWithoutModel: true
}

export function readNoChoiceOptionResult(
  result: unknown,
  request: { key: string; value: string }
): AgentSessionOptionResult | null {
  if (
    typeof result !== 'object' ||
    result === null ||
    !('version' in result) ||
    result.version !== 1 ||
    !('key' in result) ||
    result.key !== 'model' ||
    result.key !== request.key ||
    !('value' in result) ||
    result.value !== '' ||
    result.value !== request.value ||
    Object.keys(result).length !== 4 ||
    !('options' in result) ||
    typeof result.options !== 'object' ||
    result.options === null ||
    Object.getPrototypeOf(result.options) !== Object.prototype ||
    Object.keys(result.options).length !== 0
  ) {
    return null
  }
  return { key: result.key, value: result.value, options: {} }
}
