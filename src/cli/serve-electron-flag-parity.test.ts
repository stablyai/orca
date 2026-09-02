import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { normalizeServeModeArgv } from '../main/startup/serve-mode-argv'
import { BOOLEAN_FLAGS, GLOBAL_FLAGS } from './args'
import { SERVE_COMMAND_SPECS } from './specs/serve'

// Why this test lives under src/cli: the Electron rewrite duplicates the CLI's serve flag list because
// the main tsconfig cannot import the CLI project, so the parity check has to run from the CLI side.
// It fails when `orca serve` grows a flag that a direct `<binary> serve …` launch would silently drop (#12677).

// Global flags with no `--serve-*` counterpart:
// - help: a help launch is refused outright, not translated (see serve-mode-argv's HELP_FLAGS).
// - pairing-code / environment: nothing in src/main reads them, so they ride through untouched.
const UNTRANSLATED_GLOBAL_FLAGS = new Set(['help', 'pairing-code', 'environment'])

const serveSpec = SERVE_COMMAND_SPECS.find((spec) => spec.path.join(' ') === 'serve')
const translatedFlags = [...new Set(serveSpec?.allowedFlags ?? [])].filter(
  (flag) => !UNTRANSLATED_GLOBAL_FLAGS.has(flag)
)

describe('serve flag parity between the CLI spec and the Electron argv rewrite', () => {
  it('has a serve spec to compare against', () => {
    expect(translatedFlags.length).toBeGreaterThan(0)
  })

  it.each(translatedFlags)('rewrites CLI-form --%s into the --serve-* form', (flag) => {
    const takesValue = !BOOLEAN_FLAGS.has(flag)
    const argv = takesValue
      ? ['/AppRun', 'serve', `--${flag}`, 'value']
      : ['/AppRun', 'serve', `--${flag}`]
    const expected = takesValue
      ? ['/AppRun', '--serve', `--serve-${flag}`, 'value']
      : ['/AppRun', '--serve', `--serve-${flag}`]

    expect(normalizeServeModeArgv(argv)).toEqual(expected)
    if (takesValue) {
      // The equals form is the other shape `orca serve` accepts; normalize it to the internal shape.
      expect(normalizeServeModeArgv(['/AppRun', 'serve', `--${flag}=value`])).toEqual(expected)
    } else {
      // A boolean with an attached value is not a truthy assertion: the CLI reads these as
      // `flags.get(name) === true`, so `--no-pairing=false` must not disable pairing here either.
      // (`--json` is the one flag the CLI reads with `.has()`; erring toward the literal value is
      // the safe direction and only changes output format.)
      expect(normalizeServeModeArgv(['/AppRun', 'serve', `--${flag}=false`])).toEqual([
        '/AppRun',
        '--serve',
        `--${flag}=false`
      ])
    }
    // Idempotent: `orca serve` spawns the app already in this shape, and the rewrite runs over it too.
    expect(normalizeServeModeArgv(expected)).toEqual(expected)
  })

  it('emits the same --serve-* names the CLI spawns with and the main process reads', () => {
    // Why source text: serveOrcaApp spawns a real process; keeping both names visible here makes
    // the rewrite/parser contract fail loudly if either side drifts.
    const launchSource = readFileSync(join(process.cwd(), 'src/cli/runtime/launch.ts'), 'utf8')
    const serveOptionsSource = readFileSync(
      join(process.cwd(), 'src/main/startup/serve-options.ts'),
      'utf8'
    )
    const start = serveOptionsSource.indexOf('export function getServeOptions(')
    // Why bound the anchor: an unresolved indexOf slices to EOF and passes vacuously.
    expect(start).toBeGreaterThanOrEqual(0)
    const end = serveOptionsSource.indexOf('\n}', start)
    expect(end).toBeGreaterThan(start)
    const getServeOptionsBody = serveOptionsSource.slice(start, end)

    for (const flag of translatedFlags) {
      expect(launchSource).toContain(`'--serve-${flag}'`)
      expect(getServeOptionsBody).toContain(`'--serve-${flag}'`)
    }
  })

  it('keeps the untranslated allowlist tied to real global flags', () => {
    for (const flag of UNTRANSLATED_GLOBAL_FLAGS) {
      expect(GLOBAL_FLAGS).toContain(flag)
    }
  })
})
