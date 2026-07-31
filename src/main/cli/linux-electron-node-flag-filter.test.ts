import { describe, expect, it } from 'vitest'
import {
  buildLinuxElectronNodeFlagFilterShim,
  stripChromiumOnlyFlagsForNodeMode
} from './linux-electron-node-flag-filter'

describe('stripChromiumOnlyFlagsForNodeMode', () => {
  it('removes --no-sandbox and related Chromium flags (issue #11609)', () => {
    expect(
      stripChromiumOnlyFlagsForNodeMode([
        '--no-sandbox',
        '-e',
        'console.log(1)',
        '--',
        'status'
      ])
    ).toEqual(['-e', 'console.log(1)', '--', 'status'])
  })

  it('preserves unrelated flags and empty input', () => {
    expect(stripChromiumOnlyFlagsForNodeMode(['--inspect', 'app.js'])).toEqual([
      '--inspect',
      'app.js'
    ])
    expect(stripChromiumOnlyFlagsForNodeMode([])).toEqual([])
  })

  it('does not mutate the input array', () => {
    const input = ['--no-sandbox', '-e', 'x'] as const
    const output = stripChromiumOnlyFlagsForNodeMode(input)
    expect(output).toEqual(['-e', 'x'])
    expect(input).toEqual(['--no-sandbox', '-e', 'x'])
  })
})

describe('buildLinuxElectronNodeFlagFilterShim', () => {
  it('emits a bash shim that strips Chromium flags under ELECTRON_RUN_AS_NODE', () => {
    const shim = buildLinuxElectronNodeFlagFilterShim('orca-ide.bin')
    expect(shim.startsWith('#!/usr/bin/env bash')).toBe(true)
    expect(shim).toContain('orca-ide.bin')
    expect(shim).toContain('ELECTRON_RUN_AS_NODE')
    expect(shim).toContain('--no-sandbox')
    expect(shim).toContain('exec "$REAL"')
  })
})
