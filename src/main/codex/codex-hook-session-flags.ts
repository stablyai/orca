import { buildCodexManagedHook, CODEX_EVENTS, CODEX_EVENT_LABEL } from './codex-hook-definition'

type CodexEventName = (typeof CODEX_EVENTS)[number]

// Why optional: only Codex 0.150+ lists Interrupt; an older Codex drops the definition silently.
const OPTIONAL_EVENTS: ReadonlySet<CodexEventName> = new Set<CodexEventName>(['Interrupt'])

/** The events every supported Codex lists; a flag carries no hook without approval for each. */
export const CODEX_REQUIRED_EVENTS: readonly CodexEventName[] = CODEX_EVENTS.filter(
  (eventName) => !OPTIONAL_EVENTS.has(eventName)
)

/**
 * Orca's Codex status hook travels as one `-c hooks=<inline table>` session flag
 * on each Codex launch, with Codex's own approval for it in the same table, so
 * nothing is written to any Codex home. Codex keys a flag-defined hook to a
 * synthetic `<session-flags>` source and reads its approval from the same
 * layer (codex-rs hooks discovery + config_rules).
 */

/** Codex's key and hash per managed event label; a missing label carries no flag at all. */
export type CodexHookSessionTrust = Readonly<Record<string, { key: string; trustedHash: string }>>

/** TOML string spellings for one platform's argv path. */
type TomlSpelling = {
  string: (value: string) => string | null
  /** Separator between tokens; Windows forces a space so every shell quotes the whole argument. */
  gap: string
}

// Why JSON: a JSON string literal is a valid TOML basic string, and POSIX argv carries it verbatim.
const POSIX_SPELLING: TomlSpelling = { string: (value) => JSON.stringify(value), gap: '' }

// Why literal strings and no `"` or `%`: PowerShell 5.1 mangles embedded quotes in
// native arguments, and npm's codex.cmd re-parses the line in cmd.exe, which
// expands %VAR% and treats an unquoted `<`/`>` as a redirect. A value with a
// space and none of those is wrapped in quotes whole by every Windows host.
// Why ASCII only: npm's codex.cmd re-reads the flag in cmd.exe's console code page.
const WINDOWS_UNSAFE = /['"%]|[^\x20-\x7e]/
const WINDOWS_SPELLING: TomlSpelling = {
  string: (value) => (WINDOWS_UNSAFE.test(value) ? null : `'${value}'`),
  gap: ' '
}

function spellingFor(platform: NodeJS.Platform): TomlSpelling {
  return platform === 'win32' ? WINDOWS_SPELLING : POSIX_SPELLING
}

function renderHooksEntries(command: string, spelling: TomlSpelling): string[] | null {
  const commandString = spelling.string(command)
  if (commandString === null) {
    return null
  }
  const g = spelling.gap
  // Why the builder's timeout: Codex hashes its per-event normalization (Interrupt is capped at 3 s).
  return CODEX_EVENTS.map(
    (eventName) =>
      `${eventName}${g}=${g}[{${g}hooks${g}=${g}[{${g}type${g}=${g}${spelling.string('command')},${g}command${g}=${g}${commandString},${g}timeout${g}=${g}${buildCodexManagedHook(command, eventName).timeout}${g}}]${g}}]`
  )
}

function renderTable(entries: readonly string[], spelling: TomlSpelling): string {
  const g = spelling.gap
  return `{${g}${entries.join(`,${g}`)}${g}}`
}

/**
 * The `-c` argument defining Orca's hook with no approval. Only the hash lookup
 * uses it: Codex answers with the key and hash it gives each event. Null when
 * the command cannot be carried safely on this platform.
 */
export function buildCodexHookDefinitionFlag(
  command: string,
  platform: NodeJS.Platform = process.platform
): string | null {
  const spelling = spellingFor(platform)
  const entries = renderHooksEntries(command, spelling)
  return entries ? `hooks=${renderTable(entries, spelling)}` : null
}

/**
 * The `-c` argument a launch carries: Orca's hook plus Codex's approval of it.
 * Null when any piece cannot be carried safely, so a launch then carries none:
 * a hook without its approval would open Codex's review screen.
 */
export function buildCodexHookSessionFlag(
  command: string,
  trust: CodexHookSessionTrust,
  platform: NodeJS.Platform = process.platform
): string | null {
  const spelling = spellingFor(platform)
  const entries = renderHooksEntries(command, spelling)
  if (!entries) {
    return null
  }
  const g = spelling.gap
  const states: string[] = []
  for (const eventName of CODEX_EVENTS) {
    const eventTrust = trust[CODEX_EVENT_LABEL[eventName]]
    if (!eventTrust && OPTIONAL_EVENTS.has(eventName)) {
      continue
    }
    const key = eventTrust ? spelling.string(eventTrust.key) : null
    const hash = eventTrust ? spelling.string(eventTrust.trustedHash) : null
    if (key === null || hash === null) {
      return null
    }
    // Why enabled: Codex merges a user's /hooks off switch for this key per field; only Orca's setting turns Orca's hook off.
    states.push(`${key}${g}=${g}{${g}trusted_hash${g}=${g}${hash},${g}enabled${g}=${g}true${g}}`)
  }
  return `hooks=${renderTable([...entries, `state${g}=${g}${renderTable(states, spelling)}`], spelling)}`
}

/**
 * Whether `flag` defines exactly the hook `command` renders today, byte for
 * byte (command, timeout, shape), with this build's state shape for every
 * event; the approval it carries was derived for that definition, so an entry
 * that fails this is re-derived, never patched.
 */
export function codexHookSessionFlagDefines(
  flag: string,
  command: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const spelling = spellingFor(platform)
  const entries = renderHooksEntries(command, spelling)
  const g = spelling.gap
  const approvals = flag.split(`,${g}enabled${g}=${g}true${g}}`).length - 1
  return (
    entries !== null &&
    flag.startsWith(`hooks={${g}${entries.join(`,${g}`)},${g}state${g}=${g}{`) &&
    approvals >= CODEX_REQUIRED_EVENTS.length &&
    approvals <= CODEX_EVENTS.length
  )
}
