import {
  probeClaudeCliVersion,
  parseClaudeCliVersionOutput
} from '../../../claude/cli-capabilities/claude-hook-event-versions'
import { resolveClaudeCommand } from '../../../codex-cli/command'
import { runClaudeCommandProcess } from '../../../claude-accounts/sign-in/claude-command-process'
import type { ClaudeRuntimeAuthPreparation } from '../../../claude-accounts/runtime-auth/runtime-auth-types'
import { getMainHttpClient } from '../../../network/http-client'
import { ensureElectronProxyFromEnvironment } from '../../../network/proxy-settings'
import { abortSignalWithTimeout } from '../../../lib/abort-signal-with-timeout'

const versions = new Map<string, { at: number; value: Promise<string | null> }>()
const VERSION_CACHE_MS = 5 * 60_000

export function invalidateClaudeOAuthVersion(auth?: ClaudeRuntimeAuthPreparation): void {
  versions.delete(auth?.runtime === 'wsl' ? `wsl:${auth.wslDistro}` : 'host')
}

async function readVersion(auth?: ClaudeRuntimeAuthPreparation): Promise<string | null> {
  try {
    if (auth?.runtime === 'wsl') {
      if (!auth.wslDistro || !auth.wslLinuxConfigDir) {
        return null
      }
      return parseClaudeCliVersionOutput(
        await runClaudeCommandProcess(
          ['--version'],
          {
            windowsPath: auth.configDir,
            linuxPath: auth.wslLinuxConfigDir,
            wslDistro: auth.wslDistro
          },
          5_000
        )
      )
    }
    return await probeClaudeCliVersion(resolveClaudeCommand())
  } catch {
    return null
  }
}

export async function claudeOAuthHeaders(
  token: string,
  auth?: ClaudeRuntimeAuthPreparation
): Promise<Record<string, string>> {
  const key = auth?.runtime === 'wsl' ? `wsl:${auth.wslDistro}` : 'host'
  let cached = versions.get(key)
  if (!cached || Date.now() - cached.at >= VERSION_CACHE_MS) {
    cached = { at: Date.now(), value: readVersion(auth) }
    versions.set(key, cached)
  }
  const version = await cached.value
  if (version === null && versions.get(key) === cached) {
    versions.delete(key)
  }
  return {
    Authorization: `Bearer ${token}`,
    'anthropic-beta': 'oauth-2025-04-20',
    'User-Agent': version ? `claude-cli/${version} (external, cli)` : 'orca',
    'x-app': 'cli',
    Accept: 'application/json'
  }
}

export async function requestClaudeOAuth(
  pathname: string,
  headers: Record<string, string>,
  options: { body?: string; signal?: AbortSignal } = {}
): Promise<Response> {
  const url = new URL(pathname, 'https://api.anthropic.com')
  if (url.origin !== 'https://api.anthropic.com') {
    throw new Error('Invalid Claude OAuth endpoint.')
  }
  await ensureElectronProxyFromEnvironment({ probeUrl: url.href }).catch(() => {})
  return getMainHttpClient().fetch(url.href, {
    method: options.body === undefined ? 'GET' : 'POST',
    redirect: 'error',
    headers:
      options.body === undefined ? headers : { ...headers, 'Content-Type': 'application/json' },
    ...(options.body === undefined ? {} : { body: options.body }),
    signal: abortSignalWithTimeout(options.signal, 25_000)
  })
}
