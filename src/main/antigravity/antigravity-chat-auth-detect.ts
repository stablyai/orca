// What credentials the host's Antigravity chat could use, read from files and caches only: no
// gcloud, no agy.

import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import type { AntigravityChatAuthConfig } from '../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'
import type {
  AntigravityChatApiKeyStatus,
  AntigravityChatAuthDetection
} from '../../shared/rpc-contract/accounts/antigravity-accounts-params'
import {
  agentPlatformCredentialsFile,
  resolveAgentPlatformProject
} from './antigravity-agent-platform-project'
import { agyCredentialPresence } from './agy-credential-presence'

type DetectSources = {
  /** The saved config; null while it is malformed or being saved. */
  config: () => AntigravityChatAuthConfig | null
  launchEnv: () => Promise<Readonly<Record<string, string>>>
  apiKeyStatus: () => Promise<AntigravityChatApiKeyStatus>
  /** Whether agy keeps a Google login on this host, which both Google methods use. */
  agyLogin?: (homePath: string) => Promise<boolean>
  liveChats: () => number
  /** Already known, never looked up here. */
  agyVersion?: () => string | null
  /** The last answer already found; null before any. Never looked up here. */
  agySignedOut?: () => boolean | null
}

async function isFile(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isFile() === true
}

export async function detectAntigravityChatAuth(
  sources: DetectSources
): Promise<AntigravityChatAuthDetection> {
  let config: AntigravityChatAuthConfig | null
  try {
    config = sources.config()
  } catch {
    config = null
  }
  const method = config?.method ?? null
  const agyLogin =
    sources.agyLogin ??
    (async (homePath: string) => (await agyCredentialPresence(homePath)) === 'present')
  const [env, key] = await Promise.all([sources.launchEnv(), sources.apiKeyStatus()])
  // Enterprise also needs its license's project, which only Settings knows, so only a Google
  // account reads as ready from the login alone.
  const personal = await agyLogin(env.HOME ?? env.USERPROFILE ?? homedir())
  const agySignedOut = sources.agySignedOut?.() ?? null
  const adcAvailable = await isFile(agentPlatformCredentialsFile(env))
  // A switch to gcloud keeps a saved project, as the apply does; Enterprise's is its own.
  const saved = config && config.method !== 'oauth-business' ? config : {}
  const project = adcAvailable ? (await resolveAgentPlatformProject(saved, env)).project : null
  return {
    method,
    googleSignIn: { personal, business: false },
    apiKey: {
      available: key.saved || key.inEnvironment,
      source: key.saved ? 'saved' : key.inEnvironment ? 'environment' : null
    },
    adc: { available: adcAvailable, project },
    liveChats: sources.liveChats(),
    ...(sources.agyVersion ? { agyVersion: sources.agyVersion() } : {}),
    ...(agySignedOut !== null ? { agySignedOut } : {})
  }
}
