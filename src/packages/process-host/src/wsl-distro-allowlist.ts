// Internal test-box switch: keep every wsl.exe exec out of distros not on the list. Unset changes nothing.
// Out of scope: \\wsl.localhost file access, and editors given --remote wsl+<distro> (they boot it).
export const WSL_DISTRO_ALLOWLIST_ENV = 'ORCA_INTERNAL_WSL_DISTRO_ALLOWLIST'

export const WSL_DISTRO_NOT_ALLOWLISTED_CODE = 'ORCA_WSL_DISTRO_NOT_ALLOWLISTED'

// Only pure list/status/version calls may run without naming a distro.
const EXEMPT_FLAGS = new Set([
  '-l',
  '--list',
  '-v',
  '--verbose',
  '-q',
  '--quiet',
  '--running',
  '--all',
  '-o',
  '--online',
  '--status',
  '--version',
  '--help'
])
const DISTRO_FLAGS = new Set([
  '-d',
  '--distribution',
  '--distribution-id',
  '-t',
  '--terminate',
  '--unregister'
])
const VALUE_FLAGS = new Set(['-u', '--user', '--cd', '--shell-type'])
// Everything after these belongs to the guest command, not to wsl.exe.
const COMMAND_START = new Set(['--exec', '-e', '--'])
const DISTRO_NAME = /^[A-Za-z0-9._-]+$/

let parsedFor: string | undefined
let parsedAllowlist: ReadonlySet<string> | null = null
let warnedMalformed = false

/** A comma-separated list of distro names; any malformed value allows no distro at all. */
export function parseWslDistroAllowlist(value: string): ReadonlySet<string> | null {
  const names = value.split(',').map((name) => name.trim())
  if (names.some((name) => !DISTRO_NAME.test(name))) {
    return null
  }
  return new Set(names.map((name) => name.toLowerCase()))
}

function isWslProgram(program: string): boolean {
  const base = program.slice(Math.max(program.lastIndexOf('/'), program.lastIndexOf('\\')) + 1)
  const lower = base.toLowerCase()
  return lower === 'wsl' || lower === 'wsl.exe'
}

/** Why wsl.exe may not run this argv under the allowlist, or null when it may. */
function refusalReason(
  args: readonly string[],
  allowlist: ReadonlySet<string> | null
): string | null {
  const targets: string[] = []
  let exemptOnly = true
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    // wsl.exe runs its first positional argument as a command in the current target distro.
    if (COMMAND_START.has(arg) || !arg.startsWith('-')) {
      exemptOnly = false
      break
    }
    if (DISTRO_FLAGS.has(arg)) {
      exemptOnly = false
      const name = args[index + 1]
      // A distro id is not a name, so it cannot be on the list.
      targets.push(arg === '--distribution-id' ? '' : (name ?? ''))
      index++
      continue
    }
    if (arg === '--shutdown') {
      return 'wsl --shutdown stops every distro'
    }
    if (VALUE_FLAGS.has(arg)) {
      index++
    }
    if (!EXEMPT_FLAGS.has(arg)) {
      exemptOnly = false
    }
  }
  if (exemptOnly) {
    return null
  }
  if (allowlist === null) {
    return `${WSL_DISTRO_ALLOWLIST_ENV} is malformed, so no distro is allowed`
  }
  if (targets.length === 0) {
    return 'the call does not name a distro'
  }
  const refused = targets.find((name) => !allowlist.has(name.toLowerCase()))
  return refused === undefined ? null : `distro "${refused}" is not on the allowlist`
}

function readAllowlist(value: string): ReadonlySet<string> | null {
  if (parsedFor !== value) {
    parsedFor = value
    parsedAllowlist = parseWslDistroAllowlist(value)
    if (parsedAllowlist === null && !warnedMalformed) {
      warnedMalformed = true
      console.warn(
        `[process-host] ${WSL_DISTRO_ALLOWLIST_ENV} is malformed; refusing every WSL distro exec`
      )
    }
  }
  return parsedAllowlist
}

/** Throw before a wsl.exe call reaches a distro the allowlist excludes. Unset: returns at once. */
export function assertWslDistroAllowed(program: string, args: readonly string[] | string): void {
  const value = process.env[WSL_DISTRO_ALLOWLIST_ENV]
  if (value === undefined) {
    return
  }
  if (!isWslProgram(program)) {
    return
  }
  // node-pty also accepts a Windows command line; distro names never contain spaces.
  const argv = typeof args === 'string' ? args.split(/\s+/).filter(Boolean) : args
  const reason = refusalReason(argv, readAllowlist(value))
  if (reason !== null) {
    throw Object.assign(new Error(`WSL exec refused: ${reason}`), {
      code: WSL_DISTRO_NOT_ALLOWLISTED_CODE
    })
  }
}
