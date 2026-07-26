import { describe, expect, it, vi } from 'vitest'
import { MOBILE_DICTATION_KEEP_AWAKE_STARTUP_BUDGET_MS } from './mobile-dictation-session-state'
import { startMobileDictationDesktopSession } from './mobile-dictation-desktop-start'
import type { MobileDictationKeepAwakeOwner } from './mobile-dictation-keep-awake'
import type { RpcClient } from '../transport/rpc-client'

const OK_RESPONSE = { ok: true, result: {} } as const

type StartHarnessOptions = {
  sendRequest?: (method: string) => Promise<unknown>
  acquire?: () => Promise<void>
  commitRecordingStart?: () => boolean
}

function createStartHarness(options: StartHarnessOptions = {}) {
  let generation = 1
  let enabled = true
  let activeId: string | null = 'dictation-a'
  const setIdle = vi.fn()
  const release = vi.fn().mockResolvedValue(undefined)
  const commitRecordingStart = vi.fn(options.commitRecordingStart ?? (() => true))
  const rollbackRecordingStart = vi.fn()
  const sendRequest = vi.fn(
    options.sendRequest ?? (async () => OK_RESPONSE)
  ) as unknown as RpcClient['sendRequest']
  const client = { sendRequest } as RpcClient
  const keepAwakeOwner = {
    acquire: vi.fn(options.acquire ?? (async () => undefined)),
    release
  } as unknown as MobileDictationKeepAwakeOwner

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
      keepAwakeOwner,
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
    release,
    sendRequest,
    commitRecordingStart,
    rollbackRecordingStart
  }
}

describe('startMobileDictationDesktopSession', () => {
  it('does not reset UI state when a newer start supersedes keep-awake acquisition', async () => {
    let setNewerStart = () => undefined
    const harness = createStartHarness({
      acquire: async () => setNewerStart()
    })
    setNewerStart = harness.setNewerStart

    await expect(startMobileDictationDesktopSession(harness.options)).resolves.toBe(false)

    expect(harness.setIdle).not.toHaveBeenCalled()
    expect(harness.getActiveId()).toBe('dictation-b')
    expect(harness.release).toHaveBeenCalledWith('dictation-a')
    expect(harness.commitRecordingStart).not.toHaveBeenCalled()
  })

  it('sends desktop cancellation without waiting for a hung keep-awake release', async () => {
    vi.useFakeTimers()
    try {
      let goStale = () => undefined
      const harness = createStartHarness({
        acquire: () => {
          goStale()
          return new Promise<void>(() => undefined)
        }
      })
      goStale = harness.setNewerStart
      // Release queues behind the still-running acquisition, so it never settles.
      harness.release.mockReturnValue(new Promise<void>(() => undefined))

      const startPromise = startMobileDictationDesktopSession(harness.options)
      await vi.advanceTimersByTimeAsync(MOBILE_DICTATION_KEEP_AWAKE_STARTUP_BUDGET_MS)

      // Cancellation is dispatched even though release is still pending, so the
      // native session tears down without waiting out its own timeout.
      expect(harness.release).toHaveBeenCalledWith('dictation-a')
      expect(harness.sendRequest).toHaveBeenCalledWith('speech.dictation.cancel', {
        dictationId: 'dictation-a'
      })

      void startPromise
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns to idle when disable makes keep-awake acquisition stale', async () => {
    let setDisabled = () => undefined
    const harness = createStartHarness({
      acquire: async () => setDisabled()
    })
    setDisabled = harness.setDisabled

    await expect(startMobileDictationDesktopSession(harness.options)).resolves.toBe(false)

    expect(harness.setIdle).toHaveBeenCalledOnce()
    expect(harness.getActiveId()).toBeNull()
    expect(harness.release).toHaveBeenCalledWith('dictation-a')
    expect(harness.commitRecordingStart).not.toHaveBeenCalled()
  })

  it('does not hold recording start on a hung keep-awake acquisition', async () => {
    vi.useFakeTimers()
    try {
      const harness = createStartHarness({
        acquire: () => new Promise<void>(() => undefined)
      })

      const startPromise = startMobileDictationDesktopSession(harness.options)
      await vi.advanceTimersByTimeAsync(MOBILE_DICTATION_KEEP_AWAKE_STARTUP_BUDGET_MS)

      await expect(startPromise).resolves.toBe(true)
      expect(harness.commitRecordingStart).toHaveBeenCalledOnce()
      expect(harness.release).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('continues dictation when keep-awake acquisition fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const harness = createStartHarness({
      acquire: async () => {
        throw new Error('Unable to activate keep awake')
      }
    })

    await expect(startMobileDictationDesktopSession(harness.options)).resolves.toBe(true)

    expect(consoleError).toHaveBeenCalledOnce()
    consoleError.mockRestore()

    expect(harness.commitRecordingStart).toHaveBeenCalledOnce()
    expect(harness.setIdle).not.toHaveBeenCalled()
    expect(harness.getActiveId()).toBe('dictation-a')
    expect(harness.release).not.toHaveBeenCalled()
    expect(harness.sendRequest).not.toHaveBeenCalledWith('speech.dictation.cancel', {
      dictationId: 'dictation-a'
    })
  })

  it('does not surface a desktop-start failure after the start became stale', async () => {
    let setNewerStart = () => undefined
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

    expect(harness.setIdle).not.toHaveBeenCalled()
    expect(harness.getActiveId()).toBe('dictation-b')
    expect(harness.commitRecordingStart).not.toHaveBeenCalled()
  })

  it('commits recording before returning a current start to the hook', async () => {
    const harness = createStartHarness()

    await expect(startMobileDictationDesktopSession(harness.options)).resolves.toBe(true)

    expect(harness.commitRecordingStart).toHaveBeenCalledOnce()
    expect(harness.rollbackRecordingStart).not.toHaveBeenCalled()
  })

  it('cleans up the keep-awake tag and desktop session when native recording throws', async () => {
    const harness = createStartHarness({
      commitRecordingStart: () => {
        throw new Error('Audio focus request failed')
      }
    })

    await expect(startMobileDictationDesktopSession(harness.options)).rejects.toThrow(
      'Audio focus request failed'
    )

    expect(harness.release).toHaveBeenCalledWith('dictation-a')
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

    expect(harness.release).toHaveBeenCalledWith('dictation-a')
    expect(harness.sendRequest).toHaveBeenCalledWith('speech.dictation.cancel', {
      dictationId: 'dictation-a'
    })
    expect(harness.getActiveId()).toBeNull()
    expect(harness.setIdle).toHaveBeenCalledOnce()
    expect(harness.rollbackRecordingStart).toHaveBeenCalledOnce()
  })
})
