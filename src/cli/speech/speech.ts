import type { CommandHandler, HandlerContext } from '../dispatch/dispatch'
import { printResult } from '../output/command-result-output'
import { RuntimeClientError } from '../runtime/connection/types'
import type { RuntimeRpcSuccess } from '../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import { OPENAI_SPEECH_KEY_MAX_LENGTH } from '../../shared/rpc-contract/speech/speech-params'
import { readApiKeyFromStdin } from '../arguments/stdin-api-key'

type OpenAiSpeechKeyStatus = { configured: boolean; protection: string | null }

function formatKeyStatus(status: OpenAiSpeechKeyStatus): string {
  if (!status.configured) {
    return 'No OpenAI key for voice dictation on this host.'
  }
  return status.protection === 'plaintext'
    ? 'OpenAI key saved on this host, unencrypted: this host cannot seal secrets.'
    : 'OpenAI key saved on this host.'
}

export function readOpenAiKeyFromStdin(
  stdin?: AsyncIterable<unknown> & { isTTY?: boolean }
): Promise<string> {
  return readApiKeyFromStdin(
    {
      name: 'an OpenAI key',
      pipeExample: 'printf %s "$OPENAI_API_KEY" | orca speech openai-key set',
      maxLength: OPENAI_SPEECH_KEY_MAX_LENGTH
    },
    stdin
  )
}

export async function callOpenAiKeyMethod(
  client: Pick<HandlerContext['client'], 'call'>,
  method: string,
  params?: { apiKey: string }
): Promise<RuntimeRpcSuccess<OpenAiSpeechKeyStatus>> {
  try {
    return params === undefined
      ? await client.call<OpenAiSpeechKeyStatus>(method)
      : await client.call<OpenAiSpeechKeyStatus>(method, params)
  } catch (error) {
    if (error instanceof RuntimeClientError && error.code === 'method_not_found') {
      throw new RuntimeClientError(
        'incompatible_runtime',
        'This Orca server cannot store a voice dictation key yet. Update Orca on the server and try again.'
      )
    }
    throw error
  }
}

export const SPEECH_HANDLERS: Record<string, CommandHandler> = {
  'speech openai-key status': async ({ client, json }) => {
    const result = await callOpenAiKeyMethod(client, 'speech.openAiKey.status')
    printResult(result, json, formatKeyStatus)
  },
  'speech openai-key set': async ({ client, json }) => {
    const apiKey = await readOpenAiKeyFromStdin()
    const result = await callOpenAiKeyMethod(client, 'speech.openAiKey.set', { apiKey })
    printResult(result, json, formatKeyStatus)
  },
  'speech openai-key clear': async ({ client, json }) => {
    const result = await callOpenAiKeyMethod(client, 'speech.openAiKey.clear')
    printResult(result, json, formatKeyStatus)
  }
}
