import { describe, expect, it } from 'vitest'
import {
  isWslConfInteropDisabled,
  parseWslInteropProbeOutput,
  parseWslInteropRepairOutput,
  WSL_INTEROP_PROBE_SCRIPT,
  WSL_INTEROP_REPAIR_SCRIPT
} from './wsl-interop-registration'

describe('parseWslInteropProbeOutput', () => {
  it('reads present, unmounted and garbage', () => {
    expect(parseWslInteropProbeOutput('orca-wsl-interop:present\n')).toEqual({ state: 'present' })
    expect(parseWslInteropProbeOutput('motd\r\norca-wsl-interop:unmounted\r\n')).toEqual({
      state: 'unmounted'
    })
    expect(parseWslInteropProbeOutput('')).toEqual({ state: 'unknown' })
    expect(parseWslInteropProbeOutput('Exec format error')).toEqual({ state: 'unknown' })
  })

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

describe('scripts', () => {
  it('accepts either interop entry name and never flushes binfmt', () => {
    for (const script of [WSL_INTEROP_PROBE_SCRIPT, WSL_INTEROP_REPAIR_SCRIPT]) {
      expect(script).toContain('/proc/sys/fs/binfmt_misc/WSLInterop-late')
      expect(script).not.toMatch(/systemd-binfmt|\/status/)
      // --exec passes argv verbatim, but keep the payload free of guest expansions anyway.
      expect(script).not.toContain('$')
    }
    expect(WSL_INTEROP_REPAIR_SCRIPT).toContain(
      "printf ':WSLInterop:M::MZ::/init:P' > /proc/sys/fs/binfmt_misc/register"
    )
    // A failed write must not decide the verdict; only the re-check does.
    expect(WSL_INTEROP_REPAIR_SCRIPT).not.toContain('|| exit')
  })

  it('parses repair results', () => {
    expect(parseWslInteropRepairOutput('orca-wsl-interop:repaired\n')).toBe('repaired')
    expect(parseWslInteropRepairOutput('orca-wsl-interop:present\n')).toBe('present')
    expect(parseWslInteropRepairOutput('sh: permission denied')).toBe('unknown')
  })
})
