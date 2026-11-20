import { homedir } from 'node:os'
import { runProcess } from '@orca/process-host'
import type { AzureDevOpsAuthErrorCode } from '../../shared/source-control/azure-devops-auth-types'
import { resolveCommandOnLocalPath } from '../ipc/command-path/command-path-resolver'
import { mergePersistedWindowsPathAsync } from '../pty/environment/windows-environment-path'
import {
  hydrateShellPath,
  mergePathSegments
} from '../startup/shell-environment/hydrate-shell-path'

export class AzureDevOpsAuthError extends Error {
  constructor(readonly code: AzureDevOpsAuthErrorCode) {
    super(code)
    this.name = 'AzureDevOpsAuthError'
  }
}

export type AzureCliAccessToken = { accessToken: string; expiresAtMs: number }

function parseToken(stdout: string): AzureCliAccessToken {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    throw new AzureDevOpsAuthError('invalid-token-response')
  }
  if (
    !value ||
    typeof value !== 'object' ||
    !('accessToken' in value) ||
    typeof value.accessToken !== 'string' ||
    !/^[A-Za-z0-9._~+/-]+=*$/.test(value.accessToken) ||
    !('expires_on' in value)
  ) {
    throw new AzureDevOpsAuthError('invalid-token-response')
  }
  const expiry = value.expires_on
  const expiresAtMs =
    (typeof expiry === 'number' || (typeof expiry === 'string' && /^\d+$/.test(expiry))
      ? Number(expiry)
      : Number.NaN) * 1000
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    throw new AzureDevOpsAuthError('invalid-token-response')
  }
  return { accessToken: value.accessToken, expiresAtMs }
}

export async function acquireAzureCliAccessToken({
  forcePathRefresh = false
}: { forcePathRefresh?: boolean } = {}): Promise<AzureCliAccessToken> {
  const result = await (async () => {
    if (process.platform !== 'win32') {
      const hydration = await hydrateShellPath({ force: forcePathRefresh })
      if (hydration.ok) {
        mergePathSegments(hydration.segments)
      }
    }
    const env = { ...process.env }
    if (process.platform === 'win32') {
      await mergePersistedWindowsPathAsync(env, { forceRefresh: forcePathRefresh })
    }
    // An empty lookup cwd excludes Windows' usual current-directory precedence.
    const program = await resolveCommandOnLocalPath('az', { env, cwd: '' })
    if (!program) {
      throw new AzureDevOpsAuthError('cli-not-installed')
    }
    return runProcess({
      program,
      args: [
        'account',
        'get-access-token',
        '--resource',
        '499b84ac-1321-427f-aa17-267ca6975798',
        '--output',
        'json',
        '--only-show-errors'
      ],
      cwd: homedir(),
      env,
      timeoutMs: 10_000,
      maxOutputBytes: 64 * 1024,
      killOnOutputLimit: true
    })
  })().catch((error: unknown) => {
    throw error instanceof AzureDevOpsAuthError
      ? error
      : new AzureDevOpsAuthError('token-acquisition-failed')
  })

  if (result.timedOut) {
    throw new AzureDevOpsAuthError('cli-timeout')
  }
  if (result.outputTruncated) {
    throw new AzureDevOpsAuthError('invalid-token-response')
  }
  if (result.code !== 0) {
    const loginRequired = /(?:run|execute|use)\s+['`"]?az login\b|\bAADSTS(?:70043|700082)\b/i.test(
      result.stderr
    )
    throw new AzureDevOpsAuthError(loginRequired ? 'login-required' : 'token-acquisition-failed')
  }
  return parseToken(result.stdout)
}
