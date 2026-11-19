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
  // A key or ADC chat still answers whether a Google sign-in is there to switch back to.
  const googleMethod = method === 'oauth-business' ? 'oauth-business' : 'oauth-personal'
  const readGoogle = sources.googleSignIn ?? hasSavedAntigravityGoogleSignIn
  const [env, key, googleSignIn] = await Promise.all([
    sources.launchEnv(),
    sources.apiKeyStatus(),
    readGoogle(googleMethod)
  ])
  const adcAvailable = await isFile(agentPlatformCredentialsFile(env))
  const saved = config?.method === 'agent-platform' ? config : {}
  const project = adcAvailable ? (await resolveAgentPlatformProject(saved, env)).project : null
  return {
    method,
    googleSignIn,
    apiKey: {
      available: key.saved || key.inEnvironment,
      source: key.saved ? 'saved' : key.inEnvironment ? 'environment' : null
    },
    adc: { available: adcAvailable, project },
    liveChats: sources.liveChats()
  }
}
