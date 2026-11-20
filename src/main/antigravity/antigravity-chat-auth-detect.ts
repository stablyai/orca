// What credentials the host's Antigravity chat could use, read from files only: no server, no gcloud.

import { stat } from 'node:fs/promises'
import type { AntigravityChatAuthConfig } from '../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'
import type {
  AntigravityChatApiKeyStatus,
  AntigravityChatAuthDetection
} from '../../shared/rpc-contract/accounts/antigravity-accounts-params'
import {
  agentPlatformCredentialsFile,
  resolveAgentPlatformProject
} from './antigravity-agent-platform-project'
import { hasSavedAntigravityGoogleSignIn } from './antigravity-chat-saved-sign-in'

type DetectSources = {
  /** The saved config; null while it is malformed or being saved. */
  config: () => AntigravityChatAuthConfig | null
  launchEnv: () => Promise<Readonly<Record<string, string>>>
  apiKeyStatus: () => Promise<AntigravityChatApiKeyStatus>
  googleSignIn?: (method: AntigravityChatAuthConfig['method']) => Promise<boolean>
  liveChats: () => number
  agyVersion?: () => Promise<string | null>
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
  const readGoogle = sources.googleSignIn ?? hasSavedAntigravityGoogleSignIn
  const [env, key, personal, business, agyVersion] = await Promise.all([
    sources.launchEnv(),
    sources.apiKeyStatus(),
    readGoogle('oauth-personal'),
    readGoogle('oauth-business'),
    sources.agyVersion?.()
  ])
  const adcAvailable = await isFile(agentPlatformCredentialsFile(env))
  // A switch to gcloud keeps a saved project, as the apply does; Enterprise's is its own.
  const saved = config && config.method !== 'oauth-business' ? config : {}
  const project = adcAvailable ? (await resolveAgentPlatformProject(saved, env)).project : null
  return {
    method,
    googleSignIn: { personal, business },
    apiKey: {
      available: key.saved || key.inEnvironment,
      source: key.saved ? 'saved' : key.inEnvironment ? 'environment' : null
    },
    adc: { available: adcAvailable, project },
    liveChats: sources.liveChats(),
    ...(agyVersion === undefined ? {} : { agyVersion })
  }
}
