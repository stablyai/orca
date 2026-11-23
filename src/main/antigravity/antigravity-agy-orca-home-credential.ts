// agy given a method with no usable credential falls back to its own saved Google login, which on
// macOS and Windows is shared by every home. A Gemini API key is the one method it never does that
// for (it authenticates with the key alone), so only key chats run on Orca's home, and only with a
// key; otherwise they run on Orca's server, as before.

import { hasAntigravityChatApiKey } from './antigravity-chat-api-key-store'
import { envValue } from './antigravity-chat-credential'

/** Whether `env` itself carries a non-empty GEMINI_API_KEY: what agy will start with. */
export function envHasGeminiApiKey(env: Readonly<Record<string, string>>): boolean {
  return Boolean(envValue(env, 'GEMINI_API_KEY')?.trim())
}

/** Whether a Gemini API key is here for routing: GEMINI_API_KEY in `env`, or a saved key. The saved
 *  key is checked by existence, so routing never decrypts; a launch then checks its final env. A
 *  false answer only keeps the chat on Orca's server. */
export async function agyOrcaHomeKeyPresent(
  env: Readonly<Record<string, string>>,
  savedKey: () => Promise<boolean> = hasAntigravityChatApiKey
): Promise<boolean> {
  return envHasGeminiApiKey(env) || (await savedKey())
}
