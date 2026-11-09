import { describe, expect, it } from 'vitest'
import { normalizeServeModeArgv } from '../main/startup/serve-mode-argv'
import { BOOLEAN_FLAGS } from './args'
import { SERVE_COMMAND_SPECS } from './specs/serve'

// The main tsconfig cannot import CLI specs, so test the duplicated serve flag lists from here.

// Help is refused; pairing selectors pass through; force, supervise and the stale-lock
// reclaim flags apply only to the CLI parent, which starts no runtime for a reclaim.
const UNTRANSLATED_GLOBAL_FLAGS = new Set([
  'help',
  'pairing-code',
  'environment',
  'force',
  'supervise',
  'reclaim-stale-lock',
  'data-root',
  'yes'
])

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
      expect(normalizeServeModeArgv(['/AppRun', 'serve', `--${flag}=value`])).toEqual(expected)
    } else {
      // Keep attached boolean values literal, as the CLI does for flags such as --no-pairing.
      expect(normalizeServeModeArgv(['/AppRun', 'serve', `--${flag}=false`])).toEqual([
        '/AppRun',
        '--serve',
        `--${flag}=false`
      ])
    }
    // The app also normalizes argv already rewritten by the CLI launcher.
    expect(normalizeServeModeArgv(expected)).toEqual(expected)
  })
})
