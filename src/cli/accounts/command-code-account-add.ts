import type { HandlerContext } from '../dispatch/dispatch'
import { printResult } from '../output/command-result-output'
import { RuntimeClientError } from '../runtime/connection/types'
import { readApiKeyFromStdin } from '../arguments/stdin-api-key'
import type { CommandCodeCredentialsStatus } from '../../shared/agent-accounts/usage-credentials/command-code-credentials'

const COMMAND_CODE_API_KEY_MAX_LENGTH = 4_096

function formatCommandCodeStatus(status: CommandCodeCredentialsStatus): string {
  return status.apiKeyConfigured
    ? 'Command Code API key saved on this host.'
    : 'No Command Code API key saved on this host.'
}

/** Saves the key from stdin so it never lands in argv, shell history, or process listings. */
export async function addCommandCodeAccount(
  ctx: HandlerContext,
  stdin?: AsyncIterable<unknown> & { isTTY?: boolean }
): Promise<void> {
  const apiKey = await readApiKeyFromStdin(
    {
      name: 'a Command Code API key',
      pipeExample: 'printf %s "$COMMAND_CODE_API_KEY" | orca account add --agent commandcode',
      maxLength: COMMAND_CODE_API_KEY_MAX_LENGTH
    },
    stdin
  )
  try {
    const result = await ctx.client.call<CommandCodeCredentialsStatus>(
      'accounts.commandCodeSaveApiKey',
      { apiKey }
    )
    printResult(result, ctx.json, formatCommandCodeStatus)
  } catch (error) {
    if (error instanceof RuntimeClientError && error.code === 'method_not_found') {
      throw new RuntimeClientError(
        'incompatible_runtime',
        'This Orca server cannot store a Command Code key yet. Update Orca on the server and try again.'
      )
    }
    throw error
  }
}
