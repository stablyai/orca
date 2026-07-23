import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseWslUncPath } from '../../shared/wsl-paths'
import {
  AuthFilesystemOperationRegistry,
  type SharedAuthFilesystemOperation
} from './auth-filesystem-operation'

const AUTH_PRESENCE_TIMEOUT_MS = 5_000
const authPresenceProbes = new AuthFilesystemOperationRegistry<CodexAuthPresence>()

export type CodexAuthPresence = 'present' | 'absent' | 'timeout' | 'unavailable'

type CodexAuthPresenceOptions = {
  signal?: AbortSignal
  timeoutMs?: number
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function getAuthPresenceProbe(
  authPath: string
): SharedAuthFilesystemOperation<CodexAuthPresence> | null {
  // Why: aborting a Node fs promise does not necessarily cancel an already
  // issued UNC operation. Share the raw probe until it really settles so a
  // disconnected WSL home cannot accumulate native requests across polls.
  return authPresenceProbes.getOrCreate(authPath, async () => {
    try {
      await access(authPath)
      return 'present'
    } catch (error) {
      return isMissingPathError(error) ? 'absent' : 'unavailable'
    }
  })
}

// Why: the background quota poller spawns the real `codex` binary to read rate
// limits. For users who installed Codex but never signed in, that spawn can
// only fail — and worse, surfaces as an unexpected Codex process starting in
// the background. A signed-in Codex always writes an auth.json under its
// CODEX_HOME, so gating the fetch on that file keeps the poller silent until
// the user actually uses Codex.
export async function probeCodexAuthPresence(
  codexHomePath?: string | null,
  options: CodexAuthPresenceOptions = {}
): Promise<CodexAuthPresence> {
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
    const authProbe = getAuthPresenceProbe(authPath)
    if (!authProbe) {
      return 'unavailable'
    }
    const authPresence = await authProbe.wait(signal)
    if (authPresence !== 'absent' || !parseWslUncPath(home)) {
      return authPresence
    }

    // Why: ENOENT on a WSL UNC auth path can mean either a missing auth file or
    // an unavailable distro. Only an accessible Codex home proves signed-out.
    const homeProbe = getAuthPresenceProbe(home)
    if (!homeProbe) {
      return 'unavailable'
    }
    const homePresence = await homeProbe.wait(signal)
    return homePresence === 'present' ? 'absent' : 'unavailable'
  } catch {
    return timeoutSignal.aborted && !options.signal?.aborted ? 'timeout' : 'unavailable'
  }
}
