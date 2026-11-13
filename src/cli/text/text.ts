import type { CommandHandler } from '../dispatch/dispatch'
import { readTextOrFileFlag } from '../arguments/command-body-input'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../arguments/flags'
import { printResult } from '../output/command-result-output'
import { RuntimeClientError } from '../runtime/types'
import {
  TEXT_GENERATE_DEFAULT_TIMEOUT_MS,
  TEXT_GENERATE_PROMPT_MAX_CHARS,
  type TextGenerateResult
} from '../../shared/rpc-contract/text-params'

type TextGenerateSuccess = Extract<TextGenerateResult, { success: true }>

// The host stops the agent at timeoutMs; the call itself waits a little longer for that answer.
const RPC_TIMEOUT_MARGIN_MS = 15_000

export const TEXT_HANDLERS: Record<string, CommandHandler> = {
  'text generate': async ({ client, flags, cwd, json }) => {
    const agent = getRequiredStringFlag(flags, 'agent')
    const model = getOptionalStringFlag(flags, 'model')
    const effort = getOptionalStringFlag(flags, 'effort')
    const timeoutMs = getOptionalPositiveIntegerFlag(flags, 'timeout-ms')
    const prompt = (await readTextOrFileFlag(flags, cwd, 'prompt', true)) ?? ''
    if (!prompt.trim()) {
      throw new RuntimeClientError('invalid_argument', 'Prompt is empty')
    }
    if (prompt.length > TEXT_GENERATE_PROMPT_MAX_CHARS) {
      throw new RuntimeClientError(
        'invalid_argument',
        `Prompt must be at most ${TEXT_GENERATE_PROMPT_MAX_CHARS} characters`
      )
    }
    const response = await client
      .call<TextGenerateResult>(
        'text.generate',
        {
          agent,
          prompt,
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
          ...(timeoutMs ? { timeoutMs } : {})
        },
        { timeoutMs: (timeoutMs ?? TEXT_GENERATE_DEFAULT_TIMEOUT_MS) + RPC_TIMEOUT_MARGIN_MS }
      )
      .catch((error: unknown) => {
        if (error instanceof RuntimeClientError && error.code === 'method_not_found') {
          throw new RuntimeClientError(
            'incompatible_runtime',
            'The running Orca cannot generate text yet. Update or restart Orca and try again.'
          )
        }
        throw error
      })
    const result = response.result
    if (!result.success) {
      const code = result.timedOut ? 'timeout' : result.canceled ? 'canceled' : 'generation_failed'
      throw new RuntimeClientError(code, result.error)
    }
    printResult<TextGenerateSuccess>({ ...response, result }, json, (value) => value.text)
  }
}
