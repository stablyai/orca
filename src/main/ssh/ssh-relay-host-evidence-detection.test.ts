import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SshConnection } from './ssh-connection'
import { detectSshRelayHostEvidence } from './ssh-relay-host-evidence-detection'
import { getRemoteHostPlatform, type RemoteHostPlatform } from './ssh-remote-platform'

const detectorMocks = vi.hoisted(() => ({
  kernel: vi.fn(),
  libc: vi.fn(),
  libstdcxx: vi.fn(),
  darwinVersion: vi.fn(),
  darwinTranslation: vi.fn(),
  windowsCompatibility: vi.fn()
}))

vi.mock('./ssh-relay-linux-kernel-detection', () => ({
  detectSshRelayLinuxKernelRelease: detectorMocks.kernel
}))
vi.mock('./ssh-relay-libc-detection', () => ({
  detectSshRelayLinuxLibc: detectorMocks.libc
}))
vi.mock('./ssh-relay-linux-libstdcxx-detection', () => ({
  detectSshRelayLinuxLibstdcxx: detectorMocks.libstdcxx
}))
vi.mock('./ssh-relay-darwin-version-detection', () => ({
  detectSshRelayDarwinVersion: detectorMocks.darwinVersion
}))
vi.mock('./ssh-relay-darwin-translation-detection', () => ({
  detectSshRelayDarwinProcessTranslation: detectorMocks.darwinTranslation
}))
vi.mock('./ssh-relay-windows-compatibility-detection', () => ({
  detectSshRelayWindowsCompatibility: detectorMocks.windowsCompatibility
}))

const connection = {} as SshConnection

beforeEach(() => {
  vi.resetAllMocks()
  detectorMocks.kernel.mockResolvedValue('6.8.0-63-generic')
  detectorMocks.libc.mockResolvedValue({ family: 'glibc', version: '2.39' })
  detectorMocks.libstdcxx.mockResolvedValue({
    libstdcxxVersion: '6.0.33',
    glibcxxVersion: '3.4.33'
  })
  detectorMocks.darwinVersion.mockResolvedValue('15.5')
  detectorMocks.darwinTranslation.mockResolvedValue(false)
  detectorMocks.windowsCompatibility.mockResolvedValue({
    build: 26100,
    openSshVersion: '9.8p1',
    powerShellVersion: '5.1',
    dotNetFrameworkRelease: 533325
  })
})

function allDetectorCallCounts(): number[] {
  return Object.values(detectorMocks).map((mock) => mock.mock.calls.length)
}

describe('SSH relay host evidence detection', () => {
  it.each([
    ['linux-x64', 'linux', 'x64', [1, 1, 1, 0, 0, 0]],
    ['linux-arm64', 'linux', 'arm64', [1, 1, 1, 0, 0, 0]],
    ['darwin-x64', 'darwin', 'x64', [0, 0, 0, 1, 1, 0]],
    ['darwin-arm64', 'darwin', 'arm64', [0, 0, 0, 1, 1, 0]],
    ['win32-x64', 'win32', 'x64', [0, 0, 0, 0, 0, 1]],
    ['win32-arm64', 'win32', 'arm64', [0, 0, 0, 0, 0, 1]]
  ] as const)(
    'maps canonical %s and invokes only its detector family',
    async (relayPlatform, os, architecture, expectedCalls) => {
      const result = await detectSshRelayHostEvidence(
        getRemoteHostPlatform(relayPlatform),
        connection
      )

      expect(result).toMatchObject({ os, architecture, processTranslated: false })
      expect(allDetectorCallCounts()).toEqual(expectedCalls)
    }
  )

  it('composes complete Linux evidence and deeply freezes owned values', async () => {
    const result = await detectSshRelayHostEvidence(getRemoteHostPlatform('linux-x64'), connection)

    expect(result).toEqual({
      os: 'linux',
      architecture: 'x64',
      processTranslated: false,
      kernelVersion: '6.8.0-63-generic',
      libc: { family: 'glibc', version: '2.39' },
      libstdcxxVersion: '6.0.33',
      glibcxxVersion: '3.4.33'
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(result?.os === 'linux' && Object.isFrozen(result.libc)).toBe(true)
  })

  it('preserves unknown Linux libc and missing optional detector evidence', async () => {
    detectorMocks.kernel.mockResolvedValue(undefined)
    detectorMocks.libc.mockResolvedValue({ family: 'unknown' })
    detectorMocks.libstdcxx.mockResolvedValue(undefined)

    await expect(
      detectSshRelayHostEvidence(getRemoteHostPlatform('linux-arm64'), connection)
    ).resolves.toEqual({
      os: 'linux',
      architecture: 'arm64',
      processTranslated: false,
      libc: { family: 'unknown' }
    })
  })

  it.each([false, true])('preserves Darwin process translation %s', async (translated) => {
    detectorMocks.darwinTranslation.mockResolvedValue(translated)

    await expect(
      detectSshRelayHostEvidence(getRemoteHostPlatform('darwin-arm64'), connection)
    ).resolves.toEqual({
      os: 'darwin',
      architecture: 'arm64',
      processTranslated: translated,
      version: '15.5'
    })
  })

  it('keeps a known Darwin translation result when the version is unavailable', async () => {
    detectorMocks.darwinVersion.mockResolvedValue(undefined)

    await expect(
      detectSshRelayHostEvidence(getRemoteHostPlatform('darwin-x64'), connection)
    ).resolves.toEqual({
      os: 'darwin',
      architecture: 'x64',
      processTranslated: false
    })
  })

  it('returns no Darwin evidence when process translation is unknown', async () => {
    detectorMocks.darwinTranslation.mockResolvedValue(undefined)

    await expect(
      detectSshRelayHostEvidence(getRemoteHostPlatform('darwin-arm64'), connection)
    ).resolves.toBeUndefined()
  })

  it('preserves complete Windows compatibility evidence', async () => {
    await expect(
      detectSshRelayHostEvidence(getRemoteHostPlatform('win32-arm64'), connection)
    ).resolves.toEqual({
      os: 'win32',
      architecture: 'arm64',
      processTranslated: false,
      build: 26100,
      openSshVersion: '9.8p1',
      powerShellVersion: '5.1',
      dotNetFrameworkRelease: 533325
    })
  })

  it('returns conservative Windows evidence when compatibility detection is unavailable', async () => {
    detectorMocks.windowsCompatibility.mockResolvedValue(undefined)

    await expect(
      detectSshRelayHostEvidence(getRemoteHostPlatform('win32-x64'), connection)
    ).resolves.toEqual({
      os: 'win32',
      architecture: 'x64',
      processTranslated: false
    })
  })

  it('rejects inconsistent platform identity without starting any detector', async () => {
    const inconsistent = {
      ...getRemoteHostPlatform('linux-x64'),
      os: 'win32'
    } as RemoteHostPlatform

    await expect(detectSshRelayHostEvidence(inconsistent, connection)).resolves.toBeUndefined()
    expect(allDetectorCallCounts()).toEqual([0, 0, 0, 0, 0, 0])
  })

  it.each([
    ['linux-x64', ['kernel', 'libc', 'libstdcxx']],
    ['darwin-x64', ['darwinVersion', 'darwinTranslation']]
  ] as const)(
    'starts all %s family probes before awaiting a result',
    async (relayPlatform, names) => {
      const settlements = names.map(() => Promise.withResolvers<unknown>())
      names.forEach((name, index) =>
        detectorMocks[name].mockReturnValue(settlements[index].promise)
      )

      const pending = detectSshRelayHostEvidence(getRemoteHostPlatform(relayPlatform), connection)

      expect(names.map((name) => detectorMocks[name].mock.calls.length)).toEqual(names.map(() => 1))
      settlements.forEach((settlement) => settlement.resolve(undefined))
      await pending
    }
  )

  it('forwards the exact signal to every selected detector', async () => {
    const controller = new AbortController()

    await detectSshRelayHostEvidence(getRemoteHostPlatform('linux-x64'), connection, {
      signal: controller.signal
    })

    for (const mock of [detectorMocks.kernel, detectorMocks.libc, detectorMocks.libstdcxx]) {
      expect(mock).toHaveBeenCalledWith(connection, { signal: controller.signal })
    }
  })

  it('propagates cancellation without converting it to host evidence', async () => {
    const abortError = new Error('cancel host evidence')
    abortError.name = 'AbortError'
    detectorMocks.windowsCompatibility.mockRejectedValue(abortError)

    await expect(
      detectSshRelayHostEvidence(getRemoteHostPlatform('win32-x64'), connection)
    ).rejects.toBe(abortError)
  })

  it('propagates unexpected detector rejection unchanged', async () => {
    const failure = new Error('unexpected kernel detector failure')
    detectorMocks.kernel.mockRejectedValue(failure)

    await expect(
      detectSshRelayHostEvidence(getRemoteHostPlatform('linux-x64'), connection)
    ).rejects.toBe(failure)
  })
})
