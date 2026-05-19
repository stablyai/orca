import { spawn } from 'node:child_process'

export type AzureEntraAccount = {
  user: string
  tenantId: string
}

export type AzureEntraDetection =
  | { ok: true; account: AzureEntraAccount }
  | { ok: false; reason: 'not-logged-in' | 'az-not-installed' | 'malformed-output' | 'timeout' }

const PROBE_TIMEOUT_MS = 3000

export async function detectAzureEntraIdSignIn(): Promise<AzureEntraDetection> {
  let child: ReturnType<typeof spawn>
  try {
    child = spawn('az', ['account', 'show', '--output', 'json'], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      return { ok: false, reason: 'az-not-installed' }
    }
    throw error
  }

  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8')
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
  })

  return await new Promise<AzureEntraDetection>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      resolve({ ok: false, reason: 'timeout' })
    }, PROBE_TIMEOUT_MS)

    child.on('close', (code: number) => {
      clearTimeout(timer)
      if (code !== 0) {
        // Why: stderr like "Please run az login" is one of several ways az signals
        // missing creds across versions; normalize all non-zero exits to one reason.
        resolve({ ok: false, reason: 'not-logged-in' })
        return
      }
      try {
        const parsed = JSON.parse(stdout) as { user?: { name?: string }; tenantId?: string }
        if (!parsed.user?.name || !parsed.tenantId) {
          resolve({ ok: false, reason: 'malformed-output' })
          return
        }
        resolve({ ok: true, account: { user: parsed.user.name, tenantId: parsed.tenantId } })
      } catch {
        resolve({ ok: false, reason: 'malformed-output' })
      }
    })

    void stderr
  })
}

const COGNITIVE_SCOPE = 'https://cognitiveservices.azure.com/.default'

export type EntraAccessToken =
  | { ok: true; token: string }
  | { ok: false; reason: 'not-logged-in' | 'az-not-installed' | 'malformed-output' | 'timeout' }

export async function getEntraAccessTokenForCognitiveServices(): Promise<EntraAccessToken> {
  let child: ReturnType<typeof spawn>
  try {
    child = spawn(
      'az',
      ['account', 'get-access-token', '--scope', COGNITIVE_SCOPE, '--output', 'json'],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      return { ok: false, reason: 'az-not-installed' }
    }
    throw error
  }
  let stdout = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8')
  })
  return await new Promise<EntraAccessToken>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      resolve({ ok: false, reason: 'timeout' })
    }, PROBE_TIMEOUT_MS)
    child.on('close', (code: number) => {
      clearTimeout(timer)
      if (code !== 0) {
        resolve({ ok: false, reason: 'not-logged-in' })
        return
      }
      try {
        const parsed = JSON.parse(stdout) as { accessToken?: string }
        if (!parsed.accessToken) {
          resolve({ ok: false, reason: 'malformed-output' })
          return
        }
        resolve({ ok: true, token: parsed.accessToken })
      } catch {
        resolve({ ok: false, reason: 'malformed-output' })
      }
    })
  })
}
