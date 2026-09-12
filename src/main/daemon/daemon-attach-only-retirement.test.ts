import { beforeEach, describe, expect, it, vi } from 'vitest'

const trackMock = vi.hoisted(() => vi.fn())
vi.mock('../telemetry/client', () => ({ track: trackMock }))

import { SessionNotFoundError, TerminalSessionOwnerUnverifiedError } from './daemon-errors'
import {
  retireAttachOnlyAccidentalSpawn,
  retireUnexpectedAttachOnlySpawn
} from './daemon-attach-only-retirement'

beforeEach(() => trackMock.mockClear())

describe('retireAttachOnlyAccidentalSpawn', () => {
  it('sends killOwned once when incarnation proof is present', async () => {
    const request = vi.fn().mockResolvedValue(undefined)
    await expect(
      retireAttachOnlyAccidentalSpawn(36, 'session', 'inc-1', { request })
    ).resolves.toBeUndefined()
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith('killOwned', {
      sessionId: 'session',
      immediate: true,
      expectedIncarnationId: 'inc-1'
    })
    expect(trackMock).not.toHaveBeenCalled()
  })

  it('fails closed without ordinary kill when an older peer rejects killOwned', async () => {
    const request = vi.fn().mockRejectedValue(new Error('Unknown request type: killOwned'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(
        retireAttachOnlyAccidentalSpawn(30, 'session', 'inc-1', { request })
      ).rejects.toBeInstanceOf(TerminalSessionOwnerUnverifiedError)
      expect(request).toHaveBeenCalledExactlyOnceWith('killOwned', {
        sessionId: 'session',
        immediate: true,
        expectedIncarnationId: 'inc-1'
      })
      expect(trackMock).toHaveBeenCalledWith('daemon_attach_only_orphan_risk', {
        protocol_version: 30,
        kill_error_class: 'unknown'
      })
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('does not send kill or killOwned when incarnation proof is absent', async () => {
    const request = vi.fn()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(
        retireAttachOnlyAccidentalSpawn(30, 'session', undefined, { request })
      ).rejects.toBeInstanceOf(TerminalSessionOwnerUnverifiedError)
      expect(request).not.toHaveBeenCalled()
      expect(trackMock).toHaveBeenCalledWith('daemon_attach_only_orphan_risk', {
        protocol_version: 30,
        kill_error_class: 'unknown'
      })
    } finally {
      errorSpy.mockRestore()
    }
  })
})

describe('retireUnexpectedAttachOnlySpawn', () => {
  it('returns after a successful single kill', async () => {
    const kill = vi.fn().mockResolvedValue(undefined)
    await expect(retireUnexpectedAttachOnlySpawn(30, 'session', kill)).resolves.toBeUndefined()
    expect(kill).toHaveBeenCalledTimes(1)
    expect(trackMock).not.toHaveBeenCalled()
  })

  it('treats SessionNotFound as a completed retire', async () => {
    const kill = vi.fn().mockRejectedValue(new SessionNotFoundError('session'))
    await expect(retireUnexpectedAttachOnlySpawn(30, 'session', kill)).resolves.toBeUndefined()
    expect(kill).toHaveBeenCalledTimes(1)
    expect(trackMock).not.toHaveBeenCalled()
  })

  it('surfaces a failed kill with redacted support fields and no retry', async () => {
    const kill = vi.fn().mockRejectedValue(new Error('Connection lost'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(retireUnexpectedAttachOnlySpawn(30, 'session', kill)).rejects.toBeInstanceOf(
        TerminalSessionOwnerUnverifiedError
      )
      expect(kill).toHaveBeenCalledTimes(1)
      expect(errorSpy).toHaveBeenCalledWith(
        '[daemon] attach-only retire of accidental legacy spawn failed; orphan may remain',
        { protocolVersion: 30, killErrorClass: 'transport' }
      )
      expect(trackMock).toHaveBeenCalledWith('daemon_attach_only_orphan_risk', {
        protocol_version: 30,
        kill_error_class: 'transport'
      })
    } finally {
      errorSpy.mockRestore()
    }
  })
})
