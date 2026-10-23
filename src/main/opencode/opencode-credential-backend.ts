import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
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
  cwd = process.cwd(),
  signal?: AbortSignal
): Promise<OpenCodeCredentialBackend | null> {
  signal?.throwIfAborted()
  // The execution host's default CLI owns this lookup; table presence proves neither backend.
  const options = { env: environment, cwd, ...(signal ? { signal } : {}) }
  let program = await resolveCommandOnLocalPath('opencode', options)
  signal?.throwIfAborted()
  if (!program) {
    program = await resolveCommandOnLocalPath('opencode2', options)
    signal?.throwIfAborted()
  }
  if (!program) {
    return null
  }
  try {
    const binary = await realpath(program)
    signal?.throwIfAborted()
    const identity = await stat(binary)
    signal?.throwIfAborted()
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
      return await waitForPromiseWithSignal(cached.result, signal)
    }
    const result = probeBackend(binary, environment, cwd, signal)
    const entry = { result, expiresAt: Number.POSITIVE_INFINITY }
    // A caller-owned cancellation must not become another consumer's shared probe.
    if (!signal) {
      cacheProbe(key, entry)
    }
    const backend = await result
    signal?.throwIfAborted()
    entry.expiresAt = Date.now() + (backend ? 60_000 : 5_000)
    if (signal) {
      cacheProbe(key, entry)
    }
    return backend
  } catch {
    signal?.throwIfAborted()
    return null
  }
}

async function probeBackend(
  program: string,
  environment: NodeJS.ProcessEnv,
  cwd: string,
  signal?: AbortSignal
): Promise<OpenCodeCredentialBackend | null> {
  signal?.throwIfAborted()
  try {
    const result = await runProcess({
      program,
      args: ['--version'],
      env: environment,
      cwd,
      timeoutMs: 5_000,
      maxOutputBytes: 1_024,
      ...(signal ? { signal } : {})
    })
    signal?.throwIfAborted()
    if (result.code !== 0 || result.timedOut || result.outputTruncated) {
      return null
    }
    const version = /^(?:opencode\s+)?v?([12])\.\d+\.\d+(?:[-+][\w.-]+)?$/i.exec(
      result.stdout.trim()
    )
    return version?.[1] === '1' ? 'v1' : version?.[1] === '2' ? 'v2' : null
  } catch {
    signal?.throwIfAborted()
    return null
  }
}

function cacheProbe(
  key: string,
  entry: { result: Promise<OpenCodeCredentialBackend | null>; expiresAt: number }
): void {
  probes.set(key, entry)
  if (probes.size > MAX_PROBES) {
    const oldest = probes.keys().next().value
    if (oldest !== undefined) {
      probes.delete(oldest)
    }
  }
}
