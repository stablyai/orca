import { AUTOMATION_EXTRA_AGENT_ARGS_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import {
  EXTRA_AGENT_ARGS_HOST_UPDATE_REQUIRED,
  hasExtraAgentArgs
} from '../../shared/automation-extra-agent-args'
import type { RuntimeStatus } from '../../shared/runtime-types'
import type { RuntimeClient } from '../runtime-client'
import { RuntimeClientError } from '../runtime-client'

/** An explicit empty value clears saved extras. */
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

// Older runtimes silently strip extraAgentArgs and would run without the requested arguments.
export async function assertExtraAgentArgsSupported(
  client: RuntimeClient,
  extraAgentArgs: string | undefined
): Promise<void> {
  if (!hasExtraAgentArgs(extraAgentArgs)) {
    return
  }
  const status = await client.call<RuntimeStatus>('status.get')
  if (!status.result.capabilities?.includes(AUTOMATION_EXTRA_AGENT_ARGS_RUNTIME_CAPABILITY)) {
    throw new RuntimeClientError('incompatible_runtime', EXTRA_AGENT_ARGS_HOST_UPDATE_REQUIRED)
  }
}
