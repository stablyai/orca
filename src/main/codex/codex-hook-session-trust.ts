import { runProcess } from '../../shared/child-process/run-process'
import { compareAppVersions, isValidAppVersion } from '../../shared/app-version'
import { withCliRuntimeOnPath } from '../codex-cli/command'
import { getManagedCommand, getManagedScriptPath } from './codex-hook-definition'
import {
  askCodexForHookSessionTrust,
  codexTrustsHookSessionFlag
} from './codex-hook-session-flag-lookup'
import {
  isCodexHookFlagEntryName,
  publishCodexHookFlagEntry,
  readCodexHookFlagEntry,
  removeCodexHookFlagEntry,
  type CodexHookFlagEntry
} from './codex-hook-flag-table'
import { resolveWindowsShortPath, windowsShortPathRefuses } from '../windows/windows-short-path'
import {
  buildCodexHookDefinitionFlag,
  buildCodexHookSessionFlag,
  codexHookSessionFlagDefines
} from './codex-hook-session-flags'

/**
 * Derives, for one Codex binary, the `-c` flag that lets Orca's status hook
 * run approved without any file in a Codex home, and publishes it to the flag
 * table under that binary's `codex --version`. Launches carry an entry only
 * for their own binary's version: another version might hash the hook
 * differently and put it up for review. Holds no state; syncCodexHookFlags
 * decides when to call it.
 */

const VERSION_TIMEOUT_MS = 5_000
// Why longer off the launch path: macOS assesses a new codex on its first run, measured at 10-12 s.
const DERIVE_VERSION_TIMEOUT_MS = 30_000
// Why 0.133: from it, hooks/list lists all 8 hook events, SubagentStart/Stop included.
export const MIN_CODEX_HOOK_FLAG_VERSION = '0.133.0'
// Why retried: an 8.3 lookup that failed may only have timed out on a loaded machine.
const UNCARRIABLE_RETRY_MS = 60_000

type CodexHookFlagDerivation = {
  codexVersion: string | null
  entry: CodexHookFlagEntry | null
  /** Why no entry, when the binary itself is the reason; null otherwise. */
  failure: string | null
  /** The failure may pass on its own (a timeout), so it is worth asking again soon. */
  transient: boolean
}

/** The hook command a flag can carry, or why there is none. */
type CarriableHookCommand =
  | { command: string; failure: null; transient: false }
  | { command: null; failure: string; transient: boolean }

let carriable: {
  scriptPath: string
  answer: Promise<CarriableHookCommand>
  retryAt: number
} | null = null

/** Never throws. `canPublish` is checked right before the write: Codex hooks may have turned off meanwhile. */
export async function deriveCodexHookFlagEntry(
  codexPath: string,
  canPublish: () => boolean
): Promise<CodexHookFlagDerivation> {
  let codexVersion: string | null = null
  const failed = (failure: string, transient = false): CodexHookFlagDerivation => ({
    codexVersion,
    entry: null,
    failure,
    transient
  })
  const done = (entry: CodexHookFlagEntry | null): CodexHookFlagDerivation => ({
    codexVersion,
    entry,
    failure: null,
    transient: false
  })
  try {
    const probe = await probeCodexVersion(codexPath, DERIVE_VERSION_TIMEOUT_MS)
    codexVersion = probe.version
    if (!codexVersion) {
      return failed(`${codexPath} did not report its version`, probe.timedOut)
    }
    if (!isCodexHookFlagEntryName(codexVersion)) {
      return failed(`Codex version ${JSON.stringify(codexVersion)} cannot name a flag entry`)
    }
    const tooOld = readCodexTooOldForHookFlag(codexVersion)
    if (tooOld) {
      return failed(tooOld)
    }
    const carried = await resolveCarriableHookCommand()
    if (carried.command === null) {
      return failed(carried.failure, carried.transient)
    }
    const hookCommand = carried.command
    const published = readCodexHookFlagEntry(codexVersion)
    if (published && codexHookSessionFlagDefines(published.flag, hookCommand)) {
      return done(published)
    }
    // Why remove first: its approval belongs to a definition this build no longer writes.
    if (published) {
      removeCodexHookFlagEntry(codexVersion)
    }
    const trust = await askCodexForHookSessionTrust(codexPath, hookCommand)
    const flag = trust ? buildCodexHookSessionFlag(hookCommand, trust) : null
    if (!flag) {
      return failed(`${codexVersion} did not report a hash for every hook event`)
    }
    if (!(await codexTrustsHookSessionFlag(codexPath, flag, hookCommand))) {
      return failed(`${codexVersion} does not trust the hook's session-flag approval`)
    }
    const entry = { codexVersion, flag, noDaemon: await readCodexAcceptsNoDaemon(codexPath) }
    // Why checked here, synchronously with the write: an opt-out meanwhile must win.
    return done(canPublish() && publishCodexHookFlagEntry(entry) ? entry : null)
  } catch (error) {
    console.warn('[codex-hook-session] could not derive Codex hook flags:', error)
    return failed(error instanceof Error ? error.message : String(error), isTransient(error))
  }
}

// Why only these: a codex without the app-server, or one that exits early, would fail the same way every time.
function isTransient(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'CodexAppServerTimeoutError' ||
      ('syscall' in error && typeof error.syscall === 'string'))
  )
}

/**
 * Whether `flag` is one this build would write today; others are pruned and
 * re-derived. Null while this build's definition is unknown: then nothing is pruned.
 */
export async function readCodexHookFlagCheck(): Promise<((flag: string) => boolean) | null> {
  const hookCommand = (await resolveCarriableHookCommand()).command
  return hookCommand === null ? null : (flag) => codexHookSessionFlagDefines(flag, hookCommand)
}

/** Why no flag can carry Orca's hook on this machine, for status; null when one can. */
export async function readCodexHookFlagUncarriable(): Promise<string | null> {
  return (await resolveCarriableHookCommand()).failure
}

/**
 * The hook command a flag can carry. On Windows the flag holds no `"`, so a
 * profile path that needs the quoted cmd.exe spelling ("C:\Users\John Smith")
 * is carried by its 8.3 name, which the bare spelling accepts. None when the
 * volume keeps no short names: those launches carry no hook, never an unapproved one.
 */
// Why remembered: the script path is fixed for the process, and on Windows the 8.3 lookup spawns cmd.exe.
async function resolveCarriableHookCommand(): Promise<CarriableHookCommand> {
  const scriptPath = getManagedScriptPath()
  if (carriable?.scriptPath === scriptPath && Date.now() < carriable.retryAt) {
    return carriable.answer
  }
  const answer = lookupCarriableHookCommand(scriptPath)
  const current = { scriptPath, answer, retryAt: Number.POSITIVE_INFINITY }
  carriable = current
  if ((await answer).transient) {
    current.retryAt = Date.now() + UNCARRIABLE_RETRY_MS
  }
  return answer
}

async function lookupCarriableHookCommand(scriptPath: string): Promise<CarriableHookCommand> {
  const command = getManagedCommand(scriptPath)
  if (buildCodexHookDefinitionFlag(command)) {
    return { command, failure: null, transient: false }
  }
  const noShortName = {
    command: null,
    failure: `Codex status needs a short (8.3) name for ${scriptPath}, and it has none Orca can use`,
    transient: false
  }
  if (windowsShortPathRefuses(scriptPath)) {
    return noShortName
  }
  const shortPath = await resolveWindowsShortPath(scriptPath).catch(() => null)
  if (shortPath === null) {
    return {
      command: null,
      failure: `Codex status could not look up a short (8.3) name for ${scriptPath}`,
      transient: true
    }
  }
  const shortCommand = getManagedCommand(shortPath)
  // Why no short name: cmd.exe answers the long path when there is none; a `'` survives into the short one.
  return buildCodexHookDefinitionFlag(shortCommand)
    ? { command: shortCommand, failure: null, transient: false }
    : noShortName
}

/**
 * Why the user should update, for a `codex-cli X.Y.Z` older than the minimum;
 * null otherwise, including a version this cannot parse (a dev build is not old).
 */
export function readCodexTooOldForHookFlag(codexVersion: string): string | null {
  const semver = /^codex-cli (\S+)$/.exec(codexVersion.trim())?.[1]
  return semver &&
    isValidAppVersion(semver) &&
    compareAppVersions(semver, MIN_CODEX_HOOK_FLAG_VERSION) < 0
    ? `Codex ${semver} is older than ${MIN_CODEX_HOOK_FLAG_VERSION.replace(/\.0$/, '')}; update Codex for Orca status`
    : null
}

export async function readCodexVersion(codexCommand: string): Promise<string | null> {
  return (await probeCodexVersion(codexCommand)).version
}

async function probeCodexVersion(
  codexCommand: string,
  timeoutMs = VERSION_TIMEOUT_MS
): Promise<{ version: string | null; timedOut: boolean }> {
  const result = await runProcess({
    program: codexCommand,
    args: ['--version'],
    env: withCliRuntimeOnPath(codexCommand, { ...process.env }),
    timeoutMs
  })
  const version = result.code === 0 ? result.stdout.trim() : ''
  return { version: version || null, timedOut: result.timedOut === true }
}

// Why recorded per entry: a launch with an entry then skips its own `--help` probe.
async function readCodexAcceptsNoDaemon(codexCommand: string): Promise<boolean> {
  const result = await runProcess({
    program: codexCommand,
    args: ['--help'],
    env: withCliRuntimeOnPath(codexCommand, { ...process.env }),
    timeoutMs: VERSION_TIMEOUT_MS
  }).catch(() => null)
  return result?.stdout.includes('--no-daemon') ?? false
}

export const _internals = {
  resetForTesting(): void {
    carriable = null
  }
}
