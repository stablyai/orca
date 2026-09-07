import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const TOKEN_PATTERN = /^[A-Za-z0-9._~+\/-]{32,8192}$/

export type GcloudClient = {
  accessToken(): Promise<string>
  identityToken?(audience: string): Promise<string>
}

export class GcloudCommandError extends Error {
  constructor(readonly operation: string) {
    super(`${operation} is unavailable`)
  }
}

async function runGcloud(args: string[]): Promise<string> {
  try {
    const result = await execFileAsync('gcloud', args, {
      encoding: 'utf8',
      timeout: 90_000,
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...process.env,
        CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK: '1',
        CLOUDSDK_CORE_DISABLE_PROMPTS: '1',
        CLOUDSDK_CORE_DISABLE_USAGE_REPORTING: '1'
      }
    })
    return result.stdout.trim()
  } catch {
    // Gcloud stderr can echo command context; keep dashboard errors intentionally non-sensitive.
    throw new GcloudCommandError(`gcloud ${args.slice(0, 3).join(' ')}`)
  }
}

export function createGcloudClient(
  tokenCommand: (args: string[]) => Promise<string> = runGcloud
): GcloudClient {
  let cachedToken: { value: string; expiresAt: number } | null = null
  const identityTokens = new Map<string, { value: string; expiresAt: number }>()
  let pendingToken: Promise<string> | null = null
  return {
    async accessToken(): Promise<string> {
      if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value
      if (pendingToken) return await pendingToken
      // One refresh avoids concurrent gcloud processes contending on the local credential store.
      pendingToken = tokenCommand(['auth', 'print-access-token'])
        .then((token) => {
          if (!TOKEN_PATTERN.test(token)) throw new GcloudCommandError('gcloud access token')
          cachedToken = { value: token, expiresAt: Date.now() + 5 * 60_000 }
          return token
        })
        .finally(() => { pendingToken = null })
      return await pendingToken
    },
    async identityToken(audience: string): Promise<string> {
      const cached = identityTokens.get(audience)
      if (cached && cached.expiresAt > Date.now()) return cached.value
      const token = await tokenCommand([
        'auth',
        'print-identity-token',
        `--audiences=${audience}`,
        '--include-email'
      ])
      if (
        token.length > 8_192 ||
        !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
      ) {
        throw new GcloudCommandError('gcloud identity token')
      }
      identityTokens.set(audience, { value: token, expiresAt: Date.now() + 5 * 60_000 })
      return token
    }
  }
}
