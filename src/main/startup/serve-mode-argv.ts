/**
 * Detect and normalize headless-serve argv for both Electron flags (`--serve`)
 * and CLI-form subcommands (`serve --port …`) that land on the main process
 * when the AppImage/CLI redirect did not rewrite them.
 */

const SERVE_FLAG = '--serve'

// Why Map, not a record: `'toString' in {}` is true, so an object lookup turns a
// stray `serve toString` positional into a function spliced onto argv.
const CLI_TO_SERVE_FLAG = new Map([
  ['--json', '--serve-json'],
  ['--no-pairing', '--serve-no-pairing'],
  ['--mobile-pairing', '--serve-mobile-pairing'],
  ['--recipe-json', '--serve-recipe-json']
])

const CLI_TO_SERVE_VALUE_FLAG = new Map([
  ['--port', '--serve-port'],
  ['--pairing-address', '--serve-pairing-address'],
  ['--project-root', '--serve-project-root']
])

/**
 * Flags that consume the next argv token as a value (CLI-form + Electron passthrough).
 * Residual class: a flag outside this list whose space-separated value is literally `serve` would
 * read as the subcommand. Chromium switches are `--flag=value` only, so no real launch does that.
 */
const VALUE_TAKING_FLAGS = new Set([
  ...CLI_TO_SERVE_VALUE_FLAG.keys(),
  '--serve-port',
  '--serve-pairing-address',
  '--serve-project-root',
  '--user-data-dir',
  '--environment',
  '--pairing-code'
])

// Why: a CLI-form `serve` is not a serve launch when help was asked for. The AppImage redirect
// already hands these to the CLI (the same three tokens); without the refusal here,
// `<binary> serve --help` binds a network-exposed runtime server with pairing on and prints nothing.
// Scoped to the subcommand form on purpose: `--serve` is the CLI's own contract and never carries
// `--help`, so widening this would risk the one path that already works.
const HELP_FLAGS = new Set(['--help', '-h', 'help'])

function isFlagToken(token: string | undefined): boolean {
  return Boolean(token && token.startsWith('-'))
}

/**
 * Value consumption for the two scans that walk argv looking for a position: a flag takes the next
 * token only when that token is not itself flag-shaped. `normalizeServeModeArgv` consumes a strict
 * subset of this (only the CLI value flags it translates), which is the property
 * `findServeSubcommandIndex` documents below.
 */
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
    // Skipping values matters for the bare `help` token: `serve --project-root help` names a
    // directory, it does not ask for help.
    if (HELP_FLAGS.has(token)) {
      return true
    }
    i = indexAfterToken(argv, i)
  }
  return false
}

/**
 * Index of the CLI `serve` subcommand: the first positional token after flags
 * (and their values). Option *values* named `serve` are never treated as the
 * subcommand.
 *
 * What the tokens this skips must satisfy: they are a superset of the ones `normalizeServeModeArgv`
 * consumes as values. That one-directional property is what keeps the serve index off a token the
 * rewrite treats as a value — if the two ever disagreed, one half would swallow the `serve` token
 * the other half is rewriting and `--serve` would never be injected: #12677 again in a new shape.
 * Shrinking VALUE_TAKING_FLAGS to "restore symmetry" breaks it (see `--user-data-dir serve`).
 */
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

/** True when argv already has `--serve` or a bare `serve` CLI subcommand. */
export function argvRequestsServeMode(argv: readonly string[]): boolean {
  return argv.includes(SERVE_FLAG) || findServeSubcommandIndex(argv) !== -1
}

/**
 * Rewrite CLI-form `serve` invocations into the `--serve*` flag shape that
 * `getServeOptions` already understands. Idempotent when already in flag form.
 *
 * Serve flags are translated whenever serve mode is requested, including the
 * mixed `--serve --port 6768` form: leaving them untranslated is what makes a
 * security-shaped flag like `--no-pairing` read as accepted while pairing stays
 * on (#12677).
 */
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
    // Why: the CLI accepts `--port=6768` as well as `--port 6768`, but
    // getServeOptions only reads the next token, so `=` must be split apart.
    const eq = token.indexOf('=')
    const name = eq === -1 ? token : token.slice(0, eq)
    // Why only the bare form: the CLI reads its serve booleans as `flags.get(name) === true`
    // (src/cli/handlers/core.ts), so `--no-pairing=false` is NOT no-pairing there. Translating it
    // anyway dropped the value and disabled pairing for an operator who wrote `=false` — the
    // security-shaped inversion of #12677. Passing it through leaves pairing on, as the CLI does.
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
      next.push(valueFlag, token.slice(eq + 1))
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
