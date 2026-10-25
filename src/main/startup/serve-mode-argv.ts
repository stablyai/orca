/** Normalize CLI-form and Electron serve flags when a direct binary/AppImage launch bypasses CLI rewriting. */

const SERVE_FLAG = '--serve'

// Use Map: object lookup would turn a toString positional into an inherited function on argv.
const CLI_TO_SERVE_FLAG = new Map([
  ['--json', '--serve-json'],
  ['--no-pairing', '--serve-no-pairing'],
  ['--mobile-pairing', '--serve-mobile-pairing'],
  ['--grant-desktop-control', '--serve-grant-desktop-control'],
  ['--recipe-json', '--serve-recipe-json']
])

const CLI_TO_SERVE_VALUE_FLAG = new Map([
  ['--port', '--serve-port'],
  ['--pairing-address', '--serve-pairing-address'],
  ['--project-root', '--serve-project-root']
])

/** Flags consuming values in either argv shape; omitted flags with values named serve can cause false subcommand detection. */
export const VALUE_TAKING_FLAGS = new Set([
  ...CLI_TO_SERVE_VALUE_FLAG.keys(),
  '--serve-port',
  '--serve-pairing-address',
  '--serve-project-root',
  '--disable-features',
  '--user-data-dir',
  '--proxy-server',
  '--environment',
  '--pairing-code'
])

// Reject CLI-form help or it silently starts a pairing-enabled network server; internal --serve has no help contract and remains unchanged.
const HELP_FLAGS = new Set(['--help', '-h', 'help'])

function isFlagToken(token: string | undefined): boolean {
  return Boolean(token && token.startsWith('-'))
}

/** Position scans skip flag values only when not flag-shaped; this set must cover all values normalization consumes. */
function indexAfterToken(argv: readonly string[], i: number): number {
  return i + (VALUE_TAKING_FLAGS.has(argv[i]!) && !isFlagToken(argv[i + 1]) ? 2 : 1)
}

function requestsHelp(argv: readonly string[]): boolean {
  let i = 1
  while (i < argv.length) {
    const token = argv[i]!
    if (token === '--') {
      return false
    }
    // Skip values so a project-root directory named help is not mistaken for a request.
    if (HELP_FLAGS.has(token)) {
      return true
    }
    i = indexAfterToken(argv, i)
  }
  return false
}

/** Find the first positional serve, excluding values. Detection must skip a superset of rewrite-consumed values or normalization can lose --serve (#12677). */
export function findServeSubcommandIndex(argv: readonly string[]): number {
  if (requestsHelp(argv)) {
    return -1
  }
  let i = 1
  while (i < argv.length) {
    const token = argv[i]
    if (token === '--') {
      return -1
    }
    if (!isFlagToken(token)) {
      return token === 'serve' ? i : -1
    }
    i = indexAfterToken(argv, i)
  }
  return -1
}

export function argvRequestsServeMode(argv: readonly string[]): boolean {
  return argv.includes(SERVE_FLAG) || findServeSubcommandIndex(argv) !== -1
}

/** Translate CLI flags even in mixed --serve argv so no-pairing cannot be silently ignored (#12677); preserve already-normalized forms. */
export function normalizeServeModeArgv(argv: readonly string[]): string[] {
  const serveIndex = findServeSubcommandIndex(argv)
  if (serveIndex === -1 && !argv.includes(SERVE_FLAG)) {
    return [...argv]
  }

  const next: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!
    if (i === serveIndex) {
      next.push(SERVE_FLAG)
      continue
    }
    if (token === '--') {
      next.push(...argv.slice(i))
      break
    }
    // Keep internal flags canonical across accepted parser forms.
    const eq = token.indexOf('=')
    const name = eq === -1 ? token : token.slice(0, eq)
    // Translate bare booleans only: the CLI treats =false as a string, leaving pairing on. Dropping that value would disable pairing against operator intent (#12677).
    const booleanFlag = eq === -1 ? CLI_TO_SERVE_FLAG.get(name) : undefined
    if (booleanFlag) {
      next.push(booleanFlag)
      continue
    }
    const valueFlag = CLI_TO_SERVE_VALUE_FLAG.get(name)
    if (!valueFlag) {
      next.push(token)
      continue
    }
    if (eq !== -1) {
      const value = token.slice(eq + 1)
      // Preserve equals syntax for flag-shaped values so the direct parser cannot read them as another option.
      if (value.startsWith('--')) {
        next.push(`${valueFlag}=${value}`)
      } else {
        next.push(valueFlag, value)
      }
      continue
    }
    next.push(valueFlag)
    const value = argv[i + 1]
    if (value !== undefined && !isFlagToken(value)) {
      next.push(value)
      i += 1
    }
  }
  return next
}
