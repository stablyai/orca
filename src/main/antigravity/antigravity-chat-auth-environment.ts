import type { AntigravityChatAuthConfig } from '../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'
import { agentPlatformEnvironment } from './antigravity-agent-platform-project'
import { readAntigravityChatApiKey } from './antigravity-chat-api-key-store'

/** Credentials Orca supplies for the chat's account type, over what the launch environment has. */
export async function antigravityChatAuthEnvironment(
  auth: AntigravityChatAuthConfig,
  env: Readonly<Record<string, string>>
): Promise<Record<string, string>> {
  if (auth.method === 'gemini-api-key') {
    // A key pasted in Settings wins over GEMINI_API_KEY.
    const saved = await readAntigravityChatApiKey()
    return saved ? { GEMINI_API_KEY: saved } : {}
  }
  return auth.method === 'agent-platform' ? agentPlatformEnvironment(auth, env) : {}
}
