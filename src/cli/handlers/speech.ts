import type { CommandHandler, HandlerContext } from '../dispatch'
import { printResult } from '../format'
import { RuntimeClientError, type RuntimeRpcSuccess } from '../runtime-client'
import { OPENAI_SPEECH_KEY_MAX_LENGTH } from '../../shared/rpc-contract/speech-params'

type OpenAiSpeechKeyStatus = { configured: boolean; protection: string | null }

function formatKeyStatus(status: OpenAiSpeechKeyStatus): string {
  if (!status.configured) {
    return 'No OpenAI key for voice dictation on this host.'
  }
  return status.protection === 'plaintext'
    ? 'OpenAI key saved on this host, unencrypted: this host cannot seal secrets.'
    : 'OpenAI key saved on this host.'
}

// Keep secrets out of argv, shell history, and process listings.
export async function readOpenAiKeyFromStdin(
  stdin: AsyncIterable<unknown> & { isTTY?: boolean } = process.stdin
): Promise<string> {
  if (stdin.isTTY) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Pipe the key on stdin, e.g. printf %s "$OPENAI_API_KEY" | orca speech openai-key set'
    )
  }
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    bytes += buffer.length
    if (bytes > OPENAI_SPEECH_KEY_MAX_LENGTH * 4) {
      throw new RuntimeClientError('invalid_argument', 'That is too long to be an OpenAI key')
    }
    chunks.push(buffer)
  }
  const key = Buffer.concat(chunks).toString('utf8').trim()
  if (!key) {
    throw new RuntimeClientError('invalid_argument', 'No key on stdin')
  }
  if (key.length > OPENAI_SPEECH_KEY_MAX_LENGTH) {
    throw new RuntimeClientError('invalid_argument', 'That is too long to be an OpenAI key')
  }
  return key
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
