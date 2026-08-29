import type {
  GitHubAccountStatus,
  GitHubConnectTokenResult,
  GitHubDeviceFlowPollResult,
  GitHubRepoListResult
} from '../../shared/github-account'
import {
  clearStoredGitHubCredential,
  getStoredGitHubMetadata,
  hasStoredGitHubCredential,
  loadStoredGitHubSecret,
  saveGitHubCredential
} from './credential-store'
import { getEnvGitHubToken, getGitHubDeviceFlowClientId } from './github-auth-config'
import { fetchGitHubViewer } from './viewer'
import { listAccessibleGitHubRepos } from './repo-list'
import { pollGitHubDeviceFlow, startGitHubDeviceFlow } from './device-flow'

export async function connectGitHubWithToken(
  rawToken: string,
  authMethod: 'pat' | 'device-flow'
): Promise<GitHubConnectTokenResult> {
  const token = rawToken.trim()
  if (!token) {
    return { ok: false, error: 'Enter a personal access token.' }
  }
  const result = await fetchGitHubViewer(token)
  if (!result.ok) {
    // Why: calling a token invalid when the network is down sends people to
    // regenerate a credential that was fine.
    return {
      ok: false,
      error:
        result.reason === 'rejected'
          ? 'GitHub rejected this token. Check that it is valid and has the repo scope.'
          : 'Could not reach GitHub. Check your connection, then try again.'
    }
  }
  saveGitHubCredential({
    token,
    authMethod,
    login: result.data.login,
    name: result.data.name,
    avatarUrl: result.data.avatarUrl
  })
  return { ok: true, login: result.data.login }
}

export function disconnectGitHub(): void {
  clearStoredGitHubCredential()
}

// Reads env vars and plaintext metadata only — never decrypts — so the panel
// can call it on every open without a keychain prompt.
export function getGitHubAccountStatus(): GitHubAccountStatus {
  const deviceFlowAvailable = getGitHubDeviceFlowClientId() !== null
  if (getEnvGitHubToken()) {
    return {
      configured: true,
      source: 'environment',
      login: null,
      name: null,
      avatarUrl: null,
      authMethod: null,
      deviceFlowAvailable
    }
  }
  if (hasStoredGitHubCredential()) {
    const metadata = getStoredGitHubMetadata()
    return {
      configured: true,
      source: 'stored',
      login: metadata?.login ?? null,
      name: metadata?.name ?? null,
      avatarUrl: metadata?.avatarUrl ?? null,
      authMethod: metadata?.authMethod ?? null,
      deviceFlowAvailable
    }
  }
  return {
    configured: false,
    source: 'none',
    login: null,
    name: null,
    avatarUrl: null,
    authMethod: null,
    deviceFlowAvailable
  }
}

// Resolves the token only when an operation needs it (repo list, clone); never
// returns it across IPC.
export function resolveGitHubToken(): string | null {
  const envToken = getEnvGitHubToken()
  if (envToken) {
    return envToken
  }
  return loadStoredGitHubSecret({ force: true })?.token ?? null
}

export async function startGitHubAccountDeviceFlow() {
  const clientId = getGitHubDeviceFlowClientId()
  if (!clientId) {
    return { ok: false as const, error: 'GitHub device sign-in is not configured in this build.' }
  }
  return startGitHubDeviceFlow(clientId)
}

export async function pollGitHubAccountDeviceFlow(
  deviceCode: string
): Promise<GitHubDeviceFlowPollResult> {
  const clientId = getGitHubDeviceFlowClientId()
  if (!clientId) {
    return { status: 'error', error: 'GitHub device sign-in is not configured in this build.' }
  }
  const result = await pollGitHubDeviceFlow(clientId, deviceCode)
  if (result.status !== 'authorized') {
    return result
  }
  const connected = await connectGitHubWithToken(result.token, 'device-flow')
  if (!connected.ok) {
    return { status: 'error', error: connected.error }
  }
  return { status: 'connected', login: connected.login }
}

export async function listGitHubAccountRepos(): Promise<GitHubRepoListResult> {
  const token = resolveGitHubToken()
  if (!token) {
    return { ok: false, error: 'Connect a GitHub account first.' }
  }
  const result = await listAccessibleGitHubRepos(token)
  if (!result.ok) {
    return {
      ok: false,
      error:
        result.reason === 'rejected'
          ? 'GitHub rejected the saved credential. Reconnect your account.'
          : 'Could not reach GitHub. Check your connection, then try again.'
    }
  }
  return { ok: true, repos: result.data }
}
