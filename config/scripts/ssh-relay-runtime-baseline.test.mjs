import { describe, expect, it } from 'vitest'

import {
  evaluateSshRelayRuntimeBaseline,
  parseSshRelayRuntimeLibstdcxxVersion,
  parseSshRelayRuntimeLddLibstdcxxPaths
} from './ssh-relay-runtime-baseline.mjs'

describe('SSH relay runtime oldest-baseline evidence', () => {
  it('qualifies only the exact Linux userland and kernel floors', () => {
    const floor = {
      tuple: 'linux-x64-glibc',
      platform: 'linux',
      architecture: 'x64',
      glibcVersion: '2.28',
      libstdcxxVersion: '6.0.25',
      kernelVersion: '4.18.0-553.el8_10.x86_64'
    }
    expect(evaluateSshRelayRuntimeBaseline(floor)).toMatchObject({
      qualified: true,
      checks: { glibc: true, libstdcxx: true, kernel: true }
    })
    expect(evaluateSshRelayRuntimeBaseline({ ...floor, glibcVersion: '2.29' }).qualified).toBe(
      false
    )
    expect(
      evaluateSshRelayRuntimeBaseline({ ...floor, libstdcxxVersion: '6.0.26' }).qualified
    ).toBe(false)
    expect(evaluateSshRelayRuntimeBaseline({ ...floor, kernelVersion: '5.15.0' }).qualified).toBe(
      false
    )
  })

  it('records a newer-container kernel as an explicit Linux userland residual gap', () => {
    const result = evaluateSshRelayRuntimeBaseline({
      tuple: 'linux-arm64-glibc',
      scope: 'linux-userland',
      platform: 'linux',
      architecture: 'arm64',
      glibcVersion: '2.28',
      libstdcxxVersion: '6.0.25',
      kernelVersion: '6.11.0'
    })
    expect(result).toMatchObject({
      qualified: true,
      residualGaps: ['kernel'],
      checks: { kernel: false }
    })
  })

  it('requires macOS 13.5 on the tuple-native architecture', () => {
    expect(
      evaluateSshRelayRuntimeBaseline({
        tuple: 'darwin-arm64',
        platform: 'darwin',
        architecture: 'arm64',
        osVersion: '13.5.2'
      }).qualified
    ).toBe(true)
    expect(
      evaluateSshRelayRuntimeBaseline({
        tuple: 'darwin-arm64',
        platform: 'darwin',
        architecture: 'arm64',
        osVersion: '13.6.0'
      }).qualified
    ).toBe(false)
  })

  it('accepts only the declared Windows base-build floors', () => {
    for (const osVersion of ['10.0.19045.0', '10.0.20348.0']) {
      expect(
        evaluateSshRelayRuntimeBaseline({
          tuple: 'win32-x64',
          platform: 'win32',
          architecture: 'x64',
          osVersion
        }).qualified
      ).toBe(true)
    }
    expect(
      evaluateSshRelayRuntimeBaseline({
        tuple: 'win32-arm64',
        platform: 'win32',
        architecture: 'arm64',
        osVersion: '10.0.26100.1'
      }).qualified
    ).toBe(true)
    expect(
      evaluateSshRelayRuntimeBaseline({
        tuple: 'win32-x64',
        platform: 'win32',
        architecture: 'x64',
        osVersion: '10.0.22621.0'
      }).qualified
    ).toBe(false)
  })

  it('rejects tuple, architecture, and scope substitutions', () => {
    expect(() =>
      evaluateSshRelayRuntimeBaseline({ tuple: 'linux-x64-musl', scope: 'full' })
    ).toThrow(/unknown/i)
    expect(() =>
      evaluateSshRelayRuntimeBaseline({ tuple: 'win32-x64', scope: 'linux-userland' })
    ).toThrow(/scope/i)
    expect(
      evaluateSshRelayRuntimeBaseline({
        tuple: 'win32-x64',
        platform: 'win32',
        architecture: 'arm64',
        osVersion: '10.0.20348.0'
      }).qualified
    ).toBe(false)
  })

  it('extracts only resolved absolute libstdc++ paths from bounded ldd output', () => {
    expect(
      parseSshRelayRuntimeLddLibstdcxxPaths(
        [
          'linux-vdso.so.1 (0x0000ffff)',
          'libstdc++.so.6 => /lib64/libstdc++.so.6 (0x0000ffff)',
          'libm.so.6 => /lib64/libm.so.6 (0x0000ffff)'
        ].join('\n')
      )
    ).toEqual(['/lib64/libstdc++.so.6'])
    expect(() => parseSshRelayRuntimeLddLibstdcxxPaths('x'.repeat(1024 * 1024 + 1))).toThrow(
      /oversized/
    )
    for (const output of [
      'libstdc++.so.6 => not found',
      "/runtime/pty.node: /lib64/libc.so.6: version `GLIBC_2.34' not found"
    ]) {
      expect(() => parseSshRelayRuntimeLddLibstdcxxPaths(output)).toThrow(/unresolved/i)
    }
  })

  it('retains the libstdc++ SONAME major and rejects ambiguous filenames', () => {
    expect(parseSshRelayRuntimeLibstdcxxVersion(['/usr/lib64/libstdc++.so.6.0.25'])).toBe('6.0.25')
    expect(() =>
      parseSshRelayRuntimeLibstdcxxVersion([
        '/usr/lib64/libstdc++.so.6.0.25',
        '/opt/lib/libstdc++.so.6.0.26'
      ])
    ).toThrow(/one bounded/i)
    expect(() => parseSshRelayRuntimeLibstdcxxVersion(['/usr/lib64/libstdc++.so.6'])).toThrow(
      /one bounded/i
    )
  })
})
