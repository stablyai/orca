import { runProcess } from '@orca/process-host'
import { resolveCommandOnLocalPath } from '../ipc/command-path-resolver'
import { createHash } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'

export type OpenCodeCredentialBackend = 'v1' | 'v2'

// Native runtime processes own separate execution-host caches.
const probes = new Map<
  string,
  { result: Promise<OpenCodeCredentialBackend | null>; expiresAt: number }
>()
const MAX_PROBES = 32

export function resetOpenCodeCredentialBackendProbes(): void {
  probes.clear()
}

export async function detectOpenCodeCredentialBackend(
  environment: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd()
): Promise<OpenCodeCredentialBackend | null> {
  // The execution host's default CLI owns this lookup; table presence proves neither backend.
  const program =
    (await resolveCommandOnLocalPath('opencode', { env: environment, cwd })) ??
    (await resolveCommandOnLocalPath('opencode2', { env: environment, cwd }))
  if (!program) {
    return null
  }
  try {
    const binary = await realpath(program)
    const identity = await stat(binary)
    const environmentDigest = createHash('sha256')
      .update(JSON.stringify(Object.entries(environment).sort(([a], [b]) => a.localeCompare(b))))
      .digest('hex')
    const key = JSON.stringify([
      binary,
      identity.dev,
      identity.ino,
      identity.size,
      identity.mtimeMs,
      identity.ctimeMs,
      cwd,
      environmentDigest
    ])
    const cached = probes.get(key)
    if (cached && cached.expiresAt > Date.now()) {
      return cached.result
    }
    const result = probeBackend(binary, environment, cwd)
    const entry = { result, expiresAt: Number.POSITIVE_INFINITY }
    probes.set(key, entry)
    if (probes.size > MAX_PROBES) {
      const oldest = probes.keys().next().value
      if (oldest !== undefined) {
        probes.delete(oldest)
      }
    }
    const backend = await result
    entry.expiresAt = Date.now() + (backend ? 60_000 : 5_000)
    return backend
  } catch {
    return null
  }
}

async function probeBackend(
  program: string,
  environment: NodeJS.ProcessEnv,
  cwd: string
): Promise<OpenCodeCredentialBackend | null> {
  try {
    const result = await runProcess({
      program,
      args: ['--version'],
      env: environment,
      cwd,
      timeoutMs: 5_000,
      maxOutputBytes: 1_024
    })
    if (result.code !== 0 || result.timedOut || result.outputTruncated) {
      return null
    }
    const version = /^(?:opencode\s+)?v?([12])\.\d+\.\d+(?:[-+][\w.-]+)?$/i.exec(
      result.stdout.trim()
    )
    return version?.[1] === '1' ? 'v1' : version?.[1] === '2' ? 'v2' : null
  } catch {
    return null
  }
}
