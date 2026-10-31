import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseWslUncPath } from '../../shared/wsl-paths'
import {
  createAuthFilesystemOperation,
  type SharedAuthFilesystemOperation
} from './auth-filesystem-operation'

const AUTH_PRESENCE_TIMEOUT_MS = 5_000
const authPresenceProbeByPath = new Map<string, SharedAuthFilesystemOperation<CodexAuthPresence>>()

export type CodexAuthPresence = 'present' | 'absent' | 'timeout' | 'unavailable'

type CodexAuthPresenceOptions = {
  signal?: AbortSignal
  timeoutMs?: number
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function getAuthPresenceProbe(authPath: string): SharedAuthFilesystemOperation<CodexAuthPresence> {
  const existing = authPresenceProbeByPath.get(authPath)
  if (existing) {
    return existing
  }
  // Node cannot cancel issued UNC I/O; share the raw probe until settlement to prevent poll accumulation.
  const probe = createAuthFilesystemOperation(authPath, async () => {
    try {
      await access(authPath)
      return 'present'
    } catch (error) {
      return isMissingPathError(error) ? 'absent' : 'unavailable'
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

// Avoid spawning background Codex for never-signed-in users; its auth.json gates usage probes.
export async function probeCodexAuthPresence(
  codexHomePath?: string | null,
  options: CodexAuthPresenceOptions = {}
): Promise<CodexAuthPresence> {
  const home = codexHomePath ?? process.env.CODEX_HOME ?? join(homedir(), '.codex')
  const authPath = join(home, 'auth.json')
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? AUTH_PRESENCE_TIMEOUT_MS)
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal
  try {
    // UNC stat can block while WSL wakes/reconnects; async bounded waits keep other accounts refreshing.
    const authPresence = await getAuthPresenceProbe(authPath).wait(signal)
    if (authPresence !== 'absent' || !parseWslUncPath(home)) {
      return authPresence
    }

    // Missing UNC auth can mean a down distro; only an accessible home proves signed-out.
    const homePresence = await getAuthPresenceProbe(home).wait(signal)
    return homePresence === 'present' ? 'absent' : 'unavailable'
  } catch {
    return timeoutSignal.aborted && !options.signal?.aborted ? 'timeout' : 'unavailable'
  }
}
