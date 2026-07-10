import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  createAuthFilesystemOperation,
  type SharedAuthFilesystemOperation
} from './auth-filesystem-operation'

const AUTH_PRESENCE_TIMEOUT_MS = 5_000
const authPresenceProbeByPath = new Map<string, SharedAuthFilesystemOperation<boolean>>()

type CodexAuthPresenceOptions = {
  signal?: AbortSignal
  timeoutMs?: number
}

function getAuthPresenceProbe(authPath: string): SharedAuthFilesystemOperation<boolean> {
  const existing = authPresenceProbeByPath.get(authPath)
  if (existing) {
    return existing
  }
  // Why: aborting a Node fs promise does not necessarily cancel an already
  // issued UNC operation. Share the raw probe until it really settles so a
  // disconnected WSL home cannot accumulate native requests across polls.
  const probe = createAuthFilesystemOperation(authPath, () =>
    access(authPath).then(
      () => true,
      () => false
    )
  )
  authPresenceProbeByPath.set(authPath, probe)
  const clearProbe = (): void => {
    if (authPresenceProbeByPath.get(authPath) === probe) {
      authPresenceProbeByPath.delete(authPath)
    }
  }
  void probe.result.then(clearProbe, clearProbe)
  return probe
}

// Why: the background quota poller spawns the real `codex` binary to read rate
// limits. For users who installed Codex but never signed in, that spawn can
// only fail — and worse, surfaces as an unexpected Codex process starting in
// the background. A signed-in Codex always writes an auth.json under its
// CODEX_HOME, so gating the fetch on that file keeps the poller silent until
// the user actually uses Codex.
export async function codexAuthExists(
  codexHomePath?: string | null,
  options: CodexAuthPresenceOptions = {}
): Promise<boolean> {
  // Mirror Codex's own home resolution: an explicit managed-account home wins,
  // then CODEX_HOME, then the default ~/.codex.
  const home = codexHomePath ?? process.env.CODEX_HOME ?? join(homedir(), '.codex')
  const authPath = join(home, 'auth.json')
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? AUTH_PRESENCE_TIMEOUT_MS)
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal
  try {
    // Why: managed WSL homes are UNC paths. A synchronous stat can park
    // Electron main while Windows wakes or reconnects the distro; the race
    // also keeps a disconnected distro from serializing all later refreshes.
    return await getAuthPresenceProbe(authPath).wait(signal)
  } catch {
    return false
  }
}
