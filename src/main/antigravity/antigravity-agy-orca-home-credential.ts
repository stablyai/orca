// agy given a method with no usable credential falls back to its own saved Google login, which on
// macOS and Windows is shared by every home. A Gemini API key is the one method it never does that
// for (it authenticates with the key alone), so only key chats run on Orca's home, and only with a
// key; otherwise they run on Orca's server, as before.

import { readAntigravityChatApiKey } from './antigravity-chat-api-key-store'
import { envValue } from './antigravity-chat-credential'

/** Whether a Gemini API key is here: GEMINI_API_KEY in `env`, or a saved key that decrypts. A false
 *  answer only keeps the chat on Orca's server. */
export async function agyOrcaHomeKeyPresent(
  env: Readonly<Record<string, string>>,
  savedKey: () => Promise<string | null> = readAntigravityChatApiKey
): Promise<boolean> {
  return Boolean(envValue(env, 'GEMINI_API_KEY')?.trim()) || Boolean(await savedKey())
}
