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
  markHiddenRendererPty,
  setRendererPtyDeliveryInterest
} from '../ipc/pty-hidden-delivery-gate'

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

  it('is an independent off switch for the responder alone', () => {
    expect(
      isTerminalModelQueryAuthorityEnabled({ ...ALL_ON, terminalModelQueryAuthority: false })
    ).toBe(false)
  })

  it('requires both Phase-4 gate switches — no marks exist without them', () => {
    expect(
      isTerminalModelQueryAuthorityEnabled({ ...ALL_ON, terminalHiddenDeliveryGate: false })
    ).toBe(false)
    expect(
      isTerminalModelQueryAuthorityEnabled({ ...ALL_ON, terminalMainSideEffectAuthority: false })
    ).toBe(false)
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

  it('yields to registered renderer delivery interest (chunk is delivered to a sidecar)', () => {
    markHiddenRendererPty('pty-1')
    setRendererPtyDeliveryInterest('pty-1', true)
    expect(answer('pty-1')).toBe(false)
    setRendererPtyDeliveryInterest('pty-1', false)
    expect(answer('pty-1')).toBe(true)
  })

  it('yields while a remote view subscriber is attached', () => {
    markHiddenRendererPty('pty-1')
    expect(
      shouldModelAnswerHiddenPtyQueries({
        ptyId: 'pty-1',
        settings: ALL_ON,
        hasRemoteViewSubscriber: true
      })
    ).toBe(false)
  })

  it('stays silent under any kill switch', () => {
    markHiddenRendererPty('pty-1')
    expect(answer('pty-1', { terminalModelQueryAuthority: false })).toBe(false)
    expect(answer('pty-1', { terminalHiddenDeliveryGate: false })).toBe(false)
    expect(answer('pty-1', { terminalMainSideEffectAuthority: false })).toBe(false)
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
