import { describe, expect, it } from 'vitest'
import { CHROME_DEVTOOLS_COMMAND_SPECS } from './chrome-devtools'
import { parseArgs, validateCommandAndFlags, effectiveAllowedFlags } from '../args'

describe('Chrome DevTools bridge command specs', () => {
  it('does not advertise or accept embedded-browser page routing', () => {
    for (const spec of CHROME_DEVTOOLS_COMMAND_SPECS) {
      expect(effectiveAllowedFlags(spec)).not.toContain('page')
      const parsed = parseArgs(
        [...spec.path, '--page', 'embedded-tab'],
        CHROME_DEVTOOLS_COMMAND_SPECS.map((entry) => entry.path)
      )
      expect(() => validateCommandAndFlags(CHROME_DEVTOOLS_COMMAND_SPECS, parsed)).toThrow()
    }
  })
  it.each([
    ['chrome-devtools', 'tools', '--json'],
    [
      'chrome-devtools',
      'call',
      '--tool',
      'evaluate_script',
      '--arguments-file',
      'input.json',
      '--json'
    ],
    ['chrome-devtools', 'session']
  ])('accepts its documented invocation %j', (...argv) => {
    const parsed = parseArgs(
      argv,
      CHROME_DEVTOOLS_COMMAND_SPECS.map((spec) => spec.path)
    )
    expect(() => validateCommandAndFlags(CHROME_DEVTOOLS_COMMAND_SPECS, parsed)).not.toThrow()
  })
})
