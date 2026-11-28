import {
  resolveAntigravityChatAuthConfig,
  type AntigravityChatAuthConfig
} from '../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'
import { assertAntigravityChatAuthPublished } from './antigravity-chat-auth-publication'
import { agentPlatformEnvironment } from './antigravity-agent-platform-project'
import { readAntigravityChatApiKey } from './antigravity-chat-api-key-store'
import type { AcpLaunchSpec } from '../acp/launch/acp-launch-contract'

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

/** The account type Orca's Chat saves, for a launch that reads it: Orca's server, and agy on the
 *  home Orca owns for key chats; undefined for any other launch. Throws while a save
 *  is still landing or the saved value is malformed. */
export function launchAntigravityChatAuth(
  spec: Pick<AcpLaunchSpec, 'agent' | 'authMethod' | 'readsAntigravityChatAuth'>,
  saved: unknown
): AntigravityChatAuthConfig | undefined {
  if (
    spec.agent !== 'antigravity' ||
    (spec.authMethod === undefined && spec.readsAntigravityChatAuth !== true)
  ) {
    return undefined
  }
  assertAntigravityChatAuthPublished(saved)
  return resolveAntigravityChatAuthConfig(saved)
}
