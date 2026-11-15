import { describe, expect, it } from 'vitest'
import { isWslConfInteropDisabled, parseWslInteropProbeOutput } from './wsl-interop-registration'

describe('parseWslInteropProbeOutput', () => {
  it('carries the wsl.conf interop setting when the entry is missing', () => {
    expect(
      parseWslInteropProbeOutput(
        'orca-wsl-interop:missing\norca-wsl-interop:conf\n[boot]\nsystemd=true\n'
      )
    ).toEqual({ state: 'missing', interopDisabled: false })
    expect(
      parseWslInteropProbeOutput(
        'orca-wsl-interop:missing\norca-wsl-interop:conf\n[interop]\nenabled=false\n'
      )
    ).toEqual({ state: 'missing', interopDisabled: true })
  })
})

describe('isWslConfInteropDisabled', () => {
  it.each([
    ['[interop]\nenabled=false', true],
    ['[Interop]\n  Enabled = FALSE  # off', true],
    ['[interop]\nenabled="false"', true],
    ['[interop]\nenabled=0', true],
    ['[interop]\nenabled=true', false],
    ['[interop]\nappendWindowsPath=false', false],
    ['[automount]\nenabled=false', false],
    ['# [interop]\n# enabled=false', false],
    ['[interop]\nenabled=false\nenabled=true', false],
    ['', false]
  ])('%j -> %s', (conf, expected) => {
    expect(isWslConfInteropDisabled(conf)).toBe(expected)
  })
})
