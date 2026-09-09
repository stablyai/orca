/**
 * Where `officecli` lives on the host that owns a document, per execution lane.
 *
 * Detect, never install. Orca resolves the binary and, when it is absent, hands the reader a
 * command to run themselves — see `office-install-guidance.ts` and §7.3 of the plan. Nothing here
 * downloads anything.
 */
import { access } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { runProcess } from '../../shared/child-process/run-process'
import { windowsSystem32Binary } from '../../shared/child-process/windows-system-binary'
import { runWslProcess } from '../wsl/wsl-runner'
import { officecliLaneKey, type OfficecliLane } from './officecli-lane'

const LOOKUP_TIMEOUT_MS = 8_000

export type OfficecliResolution = {
  /** Absolute path in the lane's own filesystem, or null when nothing answered. */
  path: string | null
  /** How it was found; only ever shown in a diagnostic row. */
  source: 'path' | 'user-bin' | 'localappdata' | null
}

const MISSING: OfficecliResolution = { path: null, source: null }

function windowsCandidates(env: NodeJS.ProcessEnv): string[] {
  const candidates: string[] = []
  const localAppData = env.LOCALAPPDATA
  if (localAppData) {
    candidates.push(win32.join(localAppData, 'OfficeCli', 'officecli.exe'))
  }
  const home = env.USERPROFILE ?? homedir()
  if (home) {
    candidates.push(win32.join(home, '.local', 'bin', 'officecli.exe'))
  }
  return candidates
}

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/** First absolute path printed by the lookup tool; `where.exe` can print several. */
function firstAbsolutePath(stdout: string, isWindows: boolean): string | null {
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) {
      continue
    }
    if (isWindows ? /^[a-zA-Z]:\\/.test(line) : line.startsWith('/')) {
      return line
    }
  }
  return null
}

async function resolveNative(env: NodeJS.ProcessEnv): Promise<OfficecliResolution> {
  const isWindows = process.platform === 'win32'
  const lookup = isWindows
    ? { program: windowsSystem32Binary('where.exe', env), args: ['officecli.exe'] }
    : { program: '/usr/bin/env', args: ['sh', '-c', 'command -v officecli'] }
  try {
    const result = await runProcess({
      program: lookup.program,
      args: lookup.args,
      env,
      timeoutMs: LOOKUP_TIMEOUT_MS
    })
    const found = result.code === 0 ? firstAbsolutePath(result.stdout, isWindows) : null
    if (found) {
      return { path: found, source: 'path' }
    }
  } catch {
    // A lookup tool that cannot be spawned is not evidence the binary is absent; fall through
    // to the known install locations, which answer without running anything.
  }
  const candidates = isWindows
    ? windowsCandidates(env)
    : [posix.join(env.HOME ?? homedir(), '.local', 'bin', 'officecli')]
  for (const candidate of candidates) {
    if (await isExecutable(candidate)) {
      return {
        path: candidate,
        source: candidate.toLowerCase().includes('localappdata') ? 'localappdata' : 'user-bin'
      }
    }
  }
  // Why the second Windows pass is not folded into the loop: `access(X_OK)` on Windows answers for
  // readability, not executability, so the two candidate lists genuinely differ in what they prove.
  return MISSING
}

async function resolveWsl(distro: string | undefined): Promise<OfficecliResolution> {
  try {
    const result = await runWslProcess({
      script: 'command -v officecli || printf %s "$HOME/.local/bin/officecli"',
      distro,
      // The guest's login PATH is where a user-installed binary lives; without it an
      // nvm/.local install is invisible and we would report "not installed" for a host that has it.
      loginPath: 'preferred',
      timeoutMs: LOOKUP_TIMEOUT_MS
    })
    const found = firstAbsolutePath(result.stdout, false)
    if (!found) {
      return MISSING
    }
    const onPath = result.stdout.includes('/.local/bin/officecli') ? 'user-bin' : 'path'
    // The fallback branch prints a path that may not exist; prove it before claiming it.
    const proof = await runWslProcess({
      script: `test -x ${JSON.stringify(found)}`,
      distro,
      loginPath: 'none',
      timeoutMs: LOOKUP_TIMEOUT_MS
    })
    return proof.code === 0 ? { path: found, source: onPath } : MISSING
  } catch {
    return MISSING
  }
}

const cache = new Map<string, Promise<OfficecliResolution>>()

/**
 * Cached per lane. A negative result is dropped on `invalidateOfficecliResolution`, which every
 * host reconnect and every reader-driven retry calls: caching "not installed" across a
 * reconnection is how a preview keeps telling someone to install what they just installed.
 */
export function resolveOfficecli(
  lane: OfficecliLane,
  env: NodeJS.ProcessEnv = process.env
): Promise<OfficecliResolution> {
  const key = officecliLaneKey(lane)
  const cached = cache.get(key)
  if (cached) {
    return cached
  }
  const pending = (lane.kind === 'wsl' ? resolveWsl(lane.distro) : resolveNative(env)).catch(
    (): OfficecliResolution => {
      cache.delete(key)
      return MISSING
    }
  )
  cache.set(key, pending)
  return pending
}

export function invalidateOfficecliResolution(lane?: OfficecliLane): void {
  if (lane) {
    cache.delete(officecliLaneKey(lane))
    return
  }
  cache.clear()
}
