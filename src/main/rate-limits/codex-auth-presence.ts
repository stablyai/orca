import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseWslUncPath } from '../../shared/wsl-paths'
import {
  createAuthFilesystemOperation,
  type SharedAuthFilesystemOperation
} from './auth-filesystem-operation'

const AUTH_PRESENCE_TIMEOUT_MS = 5_000
type AuthFileProbe = { presence: CodexAuthPresence; fingerprint: string | null }
const authPresenceProbeByPath = new Map<string, SharedAuthFilesystemOperation<AuthFileProbe>>()
const lastAuthFingerprintByPath = new Map<string, string>()

export type CodexAuthPresence = 'present' | 'absent' | 'timeout' | 'unavailable'

type CodexAuthPresenceOptions = {
  signal?: AbortSignal
  timeoutMs?: number
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  )
}

function getAuthPresenceProbe(authPath: string): SharedAuthFilesystemOperation<AuthFileProbe> {
  const existing = authPresenceProbeByPath.get(authPath)
  if (existing) {
    return existing
  }
  // Node cannot cancel issued UNC I/O; share the raw probe until settlement to prevent poll accumulation.
  const probe = createAuthFilesystemOperation<AuthFileProbe>(authPath, async () => {
    try {
      const metadata = await stat(authPath)
      return {
        presence: 'present',
        fingerprint: `${metadata.mtimeMs}:${metadata.ctimeMs}:${metadata.size}:${metadata.ino}`
      }
    } catch (error) {
      return isMissingPathError(error)
        ? { presence: 'absent', fingerprint: 'absent' }
        : { presence: 'unavailable', fingerprint: null }
    }
  })
  authPresenceProbeByPath.set(authPath, probe)
  const clearProbe = (): void => {
    if (authPresenceProbeByPath.get(authPath) === probe) {
      authPresenceProbeByPath.delete(authPath)
    }
  }
  void probe.result.then(clearProbe, clearProbe)
  return probe
}

function codexAuthPath(codexHomePath?: string | null): string {
  return join(codexHomePath ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json')
}

async function readAuthFileProbe(authPath: string, signal: AbortSignal): Promise<AuthFileProbe> {
  const probe = await getAuthPresenceProbe(authPath).wait(signal)
  if (probe.presence !== 'absent' || !parseWslUncPath(authPath)) {
    return probe
  }
  // Why: ENOENT from a disconnected distro does not prove that its credentials were removed.
  const homeProbe = await getAuthPresenceProbe(join(authPath, '..')).wait(signal)
  return homeProbe.presence === 'present' ? probe : { presence: 'unavailable', fingerprint: null }
}

/** Compare metadata only; reauthentication must never expose credential contents. */
export async function hasCodexAuthChangedSinceLastProbe(
  codexHomePath: string | null,
  signal: AbortSignal,
  shouldRefresh: () => boolean = () => true
): Promise<boolean> {
  const authPath = codexAuthPath(codexHomePath)
  const previous = lastAuthFingerprintByPath.get(authPath)
  if (previous === undefined) {
    return false
  }
  const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(AUTH_PRESENCE_TIMEOUT_MS)])
  try {
    const current = await readAuthFileProbe(authPath, boundedSignal)
    if (
      boundedSignal.aborted ||
      current.fingerprint === null ||
      current.fingerprint === previous ||
      lastAuthFingerprintByPath.get(authPath) !== previous ||
      !shouldRefresh()
    ) {
      return false
    }
    lastAuthFingerprintByPath.set(authPath, current.fingerprint)
    return true
  } catch {
    return false
  }
}

// Avoid spawning background Codex for never-signed-in users; its auth.json gates usage probes.
export async function probeCodexAuthPresence(
  codexHomePath?: string | null,
  options: CodexAuthPresenceOptions = {}
): Promise<CodexAuthPresence> {
  const authPath = codexAuthPath(codexHomePath)
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? AUTH_PRESENCE_TIMEOUT_MS)
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal
  try {
    // UNC stat can block while WSL wakes/reconnects; async bounded waits keep other accounts refreshing.
    const probe = await readAuthFileProbe(authPath, signal)
    if (!signal.aborted && probe.fingerprint !== null) {
      lastAuthFingerprintByPath.set(authPath, probe.fingerprint)
    }
    return probe.presence
  } catch {
    return timeoutSignal.aborted && !options.signal?.aborted ? 'timeout' : 'unavailable'
  }
}
