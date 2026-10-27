// The microphone already owns the screen when desktop startup runs; failed current starts must release both, while stale starts must leave their replacement alone.
import { describe, expect, it, vi } from 'vitest'
import { startMobileDictationDesktopSession } from './mobile-dictation-desktop-start'
import type { RpcClient } from '../transport/rpc-client'

const OK_RESPONSE = { ok: true, result: {} } as const

type StartHarnessOptions = {
  sendRequest?: (method: string) => Promise<unknown>
  commitRecordingStart?: () => boolean
}

function createStartHarness(options: StartHarnessOptions = {}) {
  let generation = 1
  let enabled = true
  let activeId: string | null = 'dictation-a'
  const setIdle = vi.fn()
  const commitRecordingStart = vi.fn(options.commitRecordingStart ?? (() => true))
  const rollbackRecordingStart = vi.fn()
  const sendRequest = vi.fn(
    options.sendRequest ?? (async () => OK_RESPONSE)
  ) as unknown as RpcClient['sendRequest']
  const client = { sendRequest } as RpcClient

  return {
    options: {
      client,
      dictationId: 'dictation-a',
      generation: 1,
      getCurrentGeneration: () => generation,
      getEnabled: () => enabled,
      getActiveId: () => activeId,
      clearActiveId: (dictationId: string) => {
        if (activeId === dictationId) {
          activeId = null
        }
      },
      setIdle,
      commitRecordingStart,
      rollbackRecordingStart
    },
    setNewerStart: () => {
      generation = 2
      activeId = 'dictation-b'
    },
    setDisabled: () => {
      enabled = false
    },
    getActiveId: () => activeId,
    setIdle,
    sendRequest,
    commitRecordingStart,
    rollbackRecordingStart
  }
}

describe('startMobileDictationDesktopSession', () => {
  it('cancels a start a newer one superseded while the desktop session opened', async () => {
    let setNewerStart: () => void = () => {}
    const harness = createStartHarness({
      sendRequest: async (method) => {
        if (method === 'speech.dictation.start') {
          setNewerStart()
        }
        return OK_RESPONSE
      }
    })
    setNewerStart = harness.setNewerStart

    await expect(startMobileDictationDesktopSession(harness.options)).resolves.toBe(false)

    expect(harness.setIdle).not.toHaveBeenCalled()
    expect(harness.getActiveId()).toBe('dictation-b')
    expect(harness.commitRecordingStart).not.toHaveBeenCalled()
    expect(harness.sendRequest).toHaveBeenCalledWith('speech.dictation.cancel', {
      dictationId: 'dictation-a'
    })
  })

  it('returns to idle when a disable makes the start stale', async () => {
    let setDisabled: () => void = () => {}
    const harness = createStartHarness({
      sendRequest: async (method) => {
        if (method === 'speech.dictation.start') {
          setDisabled()
        }
        return OK_RESPONSE
      }
    })
    setDisabled = harness.setDisabled

    await expect(startMobileDictationDesktopSession(harness.options)).resolves.toBe(false)

    expect(harness.setIdle).toHaveBeenCalledOnce()
    expect(harness.getActiveId()).toBeNull()
    expect(harness.commitRecordingStart).not.toHaveBeenCalled()
  })

  it('closes the capture the hook opened when the desktop start fails', async () => {
    const harness = createStartHarness({
      sendRequest: async (method) => {
        if (method === 'speech.dictation.start') {
          throw new Error('Desktop start failed')
        }
        return OK_RESPONSE
      }
    })

    await expect(startMobileDictationDesktopSession(harness.options)).rejects.toThrow(
      'Desktop start failed'
    )

    // The hook opened capture before requesting a session; refusal must release it and the screen because no outer start catch does so.
    expect(harness.rollbackRecordingStart).toHaveBeenCalledOnce()
    expect(harness.sendRequest).toHaveBeenCalledWith('speech.dictation.cancel', {
      dictationId: 'dictation-a'
    })
  })

  it('leaves the capture alone when the failure is no longer the current start', async () => {
    let setNewerStart: () => void = () => {}
    const harness = createStartHarness({
      sendRequest: async (method) => {
        if (method === 'speech.dictation.start') {
          setNewerStart()
          throw new Error('Desktop start failed')
        }
        return OK_RESPONSE
      }
    })
    setNewerStart = harness.setNewerStart

    await expect(startMobileDictationDesktopSession(harness.options)).resolves.toBe(false)

    // Capture has no start identity; rolling back stale A would stop B’s microphone and release B’s screen.
    expect(harness.rollbackRecordingStart).not.toHaveBeenCalled()
    // A still owns its desktop session and must cancel that alone.
    expect(harness.sendRequest).toHaveBeenCalledWith('speech.dictation.cancel', {
      dictationId: 'dictation-a'
    })
  })

  it('commits recording before returning a current start to the hook', async () => {
    const harness = createStartHarness()

    await expect(startMobileDictationDesktopSession(harness.options)).resolves.toBe(true)

    expect(harness.commitRecordingStart).toHaveBeenCalledOnce()
    expect(harness.rollbackRecordingStart).not.toHaveBeenCalled()
  })

  it('cleans up the desktop session when native recording throws', async () => {
    const harness = createStartHarness({
      commitRecordingStart: () => {
        throw new Error('Audio focus request failed')
      }
    })

    await expect(startMobileDictationDesktopSession(harness.options)).rejects.toThrow(
      'Audio focus request failed'
    )

    expect(harness.sendRequest).toHaveBeenCalledWith('speech.dictation.cancel', {
      dictationId: 'dictation-a'
    })
    expect(harness.getActiveId()).toBeNull()
    expect(harness.setIdle).toHaveBeenCalledOnce()
    expect(harness.rollbackRecordingStart).toHaveBeenCalledOnce()
  })

  it('rejects and cleans up when the native recorder does not start', async () => {
    const harness = createStartHarness({ commitRecordingStart: () => false })

    await expect(startMobileDictationDesktopSession(harness.options)).rejects.toThrow(
      'Failed to start microphone recording'
    )

    expect(harness.sendRequest).toHaveBeenCalledWith('speech.dictation.cancel', {
      dictationId: 'dictation-a'
    })
    expect(harness.getActiveId()).toBeNull()
    expect(harness.setIdle).toHaveBeenCalledOnce()
    expect(harness.rollbackRecordingStart).toHaveBeenCalledOnce()
  })
})
