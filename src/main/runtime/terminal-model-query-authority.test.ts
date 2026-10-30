import { afterEach, describe, expect, it } from 'vitest'
import {
  _resetTerminalModelQueryAuthorityForTest,
  clearNativeWindowsConptyPty,
  isNativeWindowsConptyPty,
  isNativeWindowsLocalPtySpawn,
  isTerminalModelQueryAuthorityEnabled,
  markNativeWindowsConptyPty,
  shouldModelAnswerHiddenPtyQueries
} from './terminal-model-query-authority'
import {
  _resetHiddenRendererPtyDeliveryGateForTest,
  markHiddenRendererPty
} from '../ipc/pty/delivery/pty-hidden-delivery-gate'

const ALL_ON = {
  terminalMainSideEffectAuthority: true,
  terminalHiddenDeliveryGate: true,
  terminalModelQueryAuthority: true
}

afterEach(() => {
  _resetTerminalModelQueryAuthorityForTest()
  _resetHiddenRendererPtyDeliveryGateForTest()
})

describe('isTerminalModelQueryAuthorityEnabled', () => {
  it('defaults on, including for absent settings', () => {
    expect(isTerminalModelQueryAuthorityEnabled(ALL_ON)).toBe(true)
    expect(isTerminalModelQueryAuthorityEnabled({})).toBe(true)
    expect(isTerminalModelQueryAuthorityEnabled(null)).toBe(true)
    expect(isTerminalModelQueryAuthorityEnabled(undefined)).toBe(true)
  })
})

describe('shouldModelAnswerHiddenPtyQueries', () => {
  const answer = (ptyId: string, overrides: Record<string, boolean> = {}): boolean =>
    shouldModelAnswerHiddenPtyQueries({
      ptyId,
      settings: { ...ALL_ON, ...overrides },
      hasRemoteViewSubscriber: false
    })

  it('answers only for hidden-marked PTYs (the delivery decision is the reply decision)', () => {
    expect(answer('pty-1')).toBe(false)
    markHiddenRendererPty('pty-1')
    expect(answer('pty-1')).toBe(true)
    expect(answer('pty-other')).toBe(false)
  })
})

describe('isNativeWindowsLocalPtySpawn (main-side mirror of isLocalNativeWindowsPty)', () => {
  const base = {
    connectionId: null,
    cwd: 'C:\\repo',
    shellOverride: undefined,
    platform: 'win32' as NodeJS.Platform
  }

  it('matches local native Windows spawns', () => {
    expect(isNativeWindowsLocalPtySpawn(base)).toBe(true)
    expect(isNativeWindowsLocalPtySpawn({ ...base, connectionId: undefined })).toBe(true)
    expect(
      isNativeWindowsLocalPtySpawn({ ...base, shellOverride: 'C:\\Tools\\powershell.exe' })
    ).toBe(true)
  })

  it('rejects non-Windows hosts', () => {
    expect(isNativeWindowsLocalPtySpawn({ ...base, platform: 'darwin' })).toBe(false)
    expect(isNativeWindowsLocalPtySpawn({ ...base, platform: 'linux' })).toBe(false)
  })

  it('rejects SSH-backed spawns', () => {
    expect(isNativeWindowsLocalPtySpawn({ ...base, connectionId: 'ssh-1' })).toBe(false)
  })

  it('rejects WSL cwds and WSL shell overrides', () => {
    expect(
      isNativeWindowsLocalPtySpawn({ ...base, cwd: '\\\\wsl.localhost\\Ubuntu\\home\\me' })
    ).toBe(false)
    expect(isNativeWindowsLocalPtySpawn({ ...base, shellOverride: 'wsl.exe' })).toBe(false)
    expect(
      isNativeWindowsLocalPtySpawn({ ...base, shellOverride: 'C:\\Windows\\System32\\wsl.exe' })
    ).toBe(false)
    expect(isNativeWindowsLocalPtySpawn({ ...base, shellOverride: 'wsl' })).toBe(false)
  })
})

describe('native-Windows ConPTY spawn record', () => {
  it('marks, reads, and clears per PTY', () => {
    expect(isNativeWindowsConptyPty('pty-1')).toBe(false)
    markNativeWindowsConptyPty('pty-1')
    expect(isNativeWindowsConptyPty('pty-1')).toBe(true)
    expect(isNativeWindowsConptyPty('pty-2')).toBe(false)
    clearNativeWindowsConptyPty('pty-1')
    expect(isNativeWindowsConptyPty('pty-1')).toBe(false)
  })
})
