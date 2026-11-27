import type { AntigravityChatAuthConfig } from '../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'
import { scrubAntigravityAcpEnvironment } from './antigravity-acp-environment-sanitizer'

// agy's own sign-in selectors: ADC mode, a saved account, or an LLM gateway with its own key. Any
// of them could take a key chat off its key, onto a mode that reads agy's shared saved login.
const AGY_SIGN_IN_SELECTOR = /^(?:AGY_ADC_AUTH|AGY_ACCOUNT|AGY_LLM_GATEWAY_.*)$/

/** The environment for agy on a home Orca owns: only the saved method's credential, and none of agy's own sign-in selectors. On Windows an alternate-case updater flag, here or
 *  inherited, would shadow the configured uppercase entry. */
export function scrubAgyOrcaHomeEnvironment(
  env: Record<string, string>,
  inherited: NodeJS.ProcessEnv,
  auth?: AntigravityChatAuthConfig,
  platform: NodeJS.Platform = process.platform
): string[] {
  const removed = [...new Set([...Object.keys(env), ...Object.keys(inherited)])].filter((key) => {
    const normalized = platform === 'win32' ? key.toUpperCase() : key
    return (
      AGY_SIGN_IN_SELECTOR.test(normalized) ||
      (platform === 'win32' && normalized === 'AGY_CLI_DISABLE_AUTO_UPDATE' && key !== normalized)
    )
  })
  for (const key of removed) {
    delete env[key]
  }
  return [...removed, ...scrubAntigravityAcpEnvironment(env, inherited, auth)]
}
