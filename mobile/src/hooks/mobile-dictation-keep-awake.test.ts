import { beforeEach, describe, expect, it, vi } from 'vitest'

const keepAwake = vi.hoisted(() => ({
  activate: vi.fn<(tag: string) => Promise<void>>(),
  deactivate: vi.fn<(tag: string) => Promise<void>>()
}))

vi.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: keepAwake.activate,
  deactivateKeepAwake: keepAwake.deactivate
}))

import {
  MOBILE_DICTATION_KEEP_AWAKE_NATIVE_TIMEOUT_MS,
  MobileDictationKeepAwakeOwner,
  drainMobileDictationKeepAwakeCleanup
} from './mobile-dictation-keep-awake'

function deferred(): {
  promise: Promise<void>
  resolve: () => void
  reject: (error: Error) => void
} {
  let resolvePromise: (() => void) | undefined
  let rejectPromise: ((error: Error) => void) | undefined
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return {
    promise,
    resolve: () => resolvePromise?.(),
    reject: (error) => rejectPromise?.(error)
  }
}

describe('MobileDictationKeepAwakeOwner', () => {
  beforeEach(() => {
    keepAwake.activate.mockReset().mockResolvedValue(undefined)
    keepAwake.deactivate.mockReset().mockResolvedValue(undefined)
  })

  it('retries a failed native deactivation after the hook owner is replaced', async () => {
    const firstOwner = new MobileDictationKeepAwakeOwner()

    await firstOwner.acquire('first')
    const firstTag = keepAwake.activate.mock.calls[0]?.[0]
    expect(firstTag).toContain(':first')

    keepAwake.deactivate.mockRejectedValueOnce(new Error('Activity unavailable'))
    await expect(firstOwner.release('first')).rejects.toThrow('Activity unavailable')

    const replacementOwner = new MobileDictationKeepAwakeOwner()
    await replacementOwner.acquire('second')
    const secondTag = keepAwake.activate.mock.calls[1]?.[0]
    expect(secondTag).toContain(':second')
    expect(keepAwake.deactivate.mock.calls.slice(0, 2)).toEqual([[firstTag], [firstTag]])
    expect(keepAwake.deactivate.mock.invocationCallOrder[1]).toBeLessThan(
      keepAwake.activate.mock.invocationCallOrder[1] ?? 0
    )

    await replacementOwner.release('second')
  })

  it('serializes cancel and restart without letting a stale release deactivate the restart', async () => {
    const firstActivation = deferred()
    keepAwake.activate.mockImplementationOnce(() => firstActivation.promise)
    const owner = new MobileDictationKeepAwakeOwner()

    const acquireFirst = owner.acquire('first')
    const releaseFirst = owner.release('first')
    const acquireSecond = owner.acquire('second')
    firstActivation.resolve()
    await Promise.all([acquireFirst, releaseFirst, acquireSecond])

    const secondTag = keepAwake.activate.mock.calls[1]?.[0]
    await owner.release('first')
    expect(keepAwake.deactivate).toHaveBeenCalledTimes(1)

    await owner.release('second')
    expect(keepAwake.deactivate).toHaveBeenLastCalledWith(secondTag)
  })

  it('waits for an in-flight failed release before a replacement owner activates', async () => {
    const deactivation = deferred()
    const firstOwner = new MobileDictationKeepAwakeOwner()
    await firstOwner.acquire('first')
    keepAwake.deactivate.mockImplementationOnce(() => deactivation.promise)

    const releaseFirst = firstOwner.release('first')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(keepAwake.deactivate).toHaveBeenCalledOnce()

    const replacementOwner = new MobileDictationKeepAwakeOwner()
    const acquireReplacement = replacementOwner.acquire('replacement')
    expect(keepAwake.activate).toHaveBeenCalledOnce()

    deactivation.reject(new Error('Activity unavailable'))
    await expect(releaseFirst).rejects.toThrow('Activity unavailable')
    await acquireReplacement

    expect(keepAwake.deactivate).toHaveBeenCalledTimes(2)
    expect(keepAwake.activate).toHaveBeenCalledTimes(2)
    expect(keepAwake.deactivate.mock.invocationCallOrder[1]).toBeLessThan(
      keepAwake.activate.mock.invocationCallOrder[1] ?? 0
    )
    await replacementOwner.release('replacement')
  })

  it('does not fail a fresh acquire when stale-tag cleanup keeps failing', async () => {
    const firstOwner = new MobileDictationKeepAwakeOwner()
    await firstOwner.acquire('first')

    // Both the release deactivate and its trailing drain retry fail.
    keepAwake.deactivate
      .mockRejectedValueOnce(new Error('Activity unavailable'))
      .mockRejectedValueOnce(new Error('Activity unavailable'))
    await expect(firstOwner.release('first')).rejects.toThrow('Activity unavailable')

    keepAwake.deactivate.mockRejectedValueOnce(new Error('Activity unavailable'))
    const replacementOwner = new MobileDictationKeepAwakeOwner()
    await expect(replacementOwner.acquire('second')).resolves.toBeUndefined()
    expect(keepAwake.activate).toHaveBeenCalledTimes(2)

    // The still-pending first tag drains once a deactivation finally succeeds.
    await replacementOwner.release('second')
    expect(keepAwake.deactivate.mock.calls.filter(([tag]) => tag.includes(':first'))).toHaveLength(
      4
    )
  })

  it('times out a never-settling native call instead of wedging the queue', async () => {
    vi.useFakeTimers()
    try {
      keepAwake.activate.mockImplementationOnce(() => new Promise<void>(() => undefined))
      const hungOwner = new MobileDictationKeepAwakeOwner()
      const hungAcquire = hungOwner.acquire('hung')
      // Drain microtasks to quiescence so the timeout timer is registered.
      await vi.advanceTimersByTimeAsync(0)

      await vi.advanceTimersByTimeAsync(MOBILE_DICTATION_KEEP_AWAKE_NATIVE_TIMEOUT_MS)
      await expect(hungAcquire).rejects.toThrow('Keep-awake native call timed out')

      // The queue must advance, and another owner's drain must spare the
      // still-wanted maybe-late activation.
      const nextOwner = new MobileDictationKeepAwakeOwner()
      await nextOwner.acquire('next')
      expect(keepAwake.deactivate).not.toHaveBeenCalled()
      expect(keepAwake.activate.mock.calls[1]?.[0]).toContain(':next')

      // Once its own dictation ends, the orphan gets cleaned.
      await hungOwner.release('hung')
      expect(keepAwake.deactivate.mock.calls.filter(([tag]) => tag.includes(':hung'))).toHaveLength(
        1
      )
      await nextOwner.release('next')
    } finally {
      vi.useRealTimers()
    }
  })

  it('adopts a timed-out activation that lands late while the dictation is live', async () => {
    vi.useFakeTimers()
    try {
      const lateActivation = deferred()
      keepAwake.activate.mockImplementationOnce(() => lateActivation.promise)
      const owner = new MobileDictationKeepAwakeOwner()
      const acquire = owner.acquire('late')
      await vi.advanceTimersByTimeAsync(0)

      await vi.advanceTimersByTimeAsync(MOBILE_DICTATION_KEEP_AWAKE_NATIVE_TIMEOUT_MS)
      await expect(acquire).rejects.toThrow('Keep-awake native call timed out')

      lateActivation.resolve()
      await vi.advanceTimersByTimeAsync(0)
      // Adopted, not deactivated: protection stays on for the live dictation.
      expect(keepAwake.deactivate).not.toHaveBeenCalled()

      await owner.release('late')
      expect(keepAwake.deactivate.mock.calls.filter(([tag]) => tag.includes(':late'))).toHaveLength(
        1
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not let another owner drain a still-wanted timed-out activation', async () => {
    vi.useFakeTimers()
    try {
      const lateActivation = deferred()
      keepAwake.activate.mockImplementationOnce(() => lateActivation.promise)
      const ownerA = new MobileDictationKeepAwakeOwner()
      const acquireA = ownerA.acquire('wanted')
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(MOBILE_DICTATION_KEEP_AWAKE_NATIVE_TIMEOUT_MS)
      await expect(acquireA).rejects.toThrow('Keep-awake native call timed out')

      const ownerB = new MobileDictationKeepAwakeOwner()
      await ownerB.acquire('other')
      expect(keepAwake.deactivate).not.toHaveBeenCalled()

      lateActivation.resolve()
      await vi.advanceTimersByTimeAsync(0)
      // Adopted for owner A; released like a normal activation afterwards.
      await ownerA.release('wanted')
      expect(
        keepAwake.deactivate.mock.calls.filter(([tag]) => tag.includes(':wanted'))
      ).toHaveLength(1)
      await ownerB.release('other')
    } finally {
      vi.useRealTimers()
    }
  })

  it('deactivates a late-landing activation once its dictation has ended', async () => {
    vi.useFakeTimers()
    try {
      const lateActivation = deferred()
      keepAwake.activate.mockImplementationOnce(() => lateActivation.promise)
      const owner = new MobileDictationKeepAwakeOwner()
      const acquire = owner.acquire('ended')
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(MOBILE_DICTATION_KEEP_AWAKE_NATIVE_TIMEOUT_MS)
      await expect(acquire).rejects.toThrow('Keep-awake native call timed out')

      await owner.release('ended')
      lateActivation.resolve()
      await vi.waitFor(() => expect(keepAwake.deactivate).toHaveBeenCalledTimes(2))
      expect(keepAwake.deactivate.mock.calls.every(([tag]) => tag.includes(':ended'))).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries a timed-out final deactivation via the foreground drain', async () => {
    vi.useFakeTimers()
    try {
      const owner = new MobileDictationKeepAwakeOwner()
      await owner.acquire('final')
      const tag = keepAwake.activate.mock.calls[0]?.[0]
      // The release deactivate times out and its trailing drain retry fails.
      keepAwake.deactivate
        .mockImplementationOnce(() => new Promise<void>(() => undefined))
        .mockRejectedValueOnce(new Error('Activity unavailable'))
      const release = owner.release('final')
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(MOBILE_DICTATION_KEEP_AWAKE_NATIVE_TIMEOUT_MS)
      await expect(release).rejects.toThrow('Keep-awake native call timed out')
      expect(keepAwake.deactivate).toHaveBeenCalledTimes(2)

      await drainMobileDictationKeepAwakeCleanup()
      expect(keepAwake.deactivate).toHaveBeenCalledTimes(3)
      expect(keepAwake.deactivate).toHaveBeenLastCalledWith(tag)
    } finally {
      vi.useRealTimers()
    }
  })

  it('drains orphaned tags on release, not only on the next acquire', async () => {
    vi.useFakeTimers()
    try {
      keepAwake.activate.mockImplementationOnce(() => new Promise<void>(() => undefined))
      const owner = new MobileDictationKeepAwakeOwner()
      const acquire = owner.acquire('orphan')
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(MOBILE_DICTATION_KEEP_AWAKE_NATIVE_TIMEOUT_MS)
      await expect(acquire).rejects.toThrow('Keep-awake native call timed out')

      // The dictation ends without another acquire; release must still clean.
      await owner.release('orphan')
      expect(
        keepAwake.deactivate.mock.calls.filter(([tag]) => tag.includes(':orphan'))
      ).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('recovers on foreground reacquire after a failed initial acquisition', async () => {
    keepAwake.activate.mockRejectedValueOnce(new Error('Unable to activate keep awake'))
    const owner = new MobileDictationKeepAwakeOwner()
    await expect(owner.acquire('current')).rejects.toThrow('Unable to activate keep awake')
    expect(keepAwake.deactivate).not.toHaveBeenCalled()

    await owner.reacquire('current')
    const tag = keepAwake.activate.mock.calls[1]?.[0]
    expect(keepAwake.activate).toHaveBeenCalledTimes(2)
    expect(tag).toContain(':current')
    // A definite rejection activated nothing, so recovery must not deactivate.
    expect(keepAwake.deactivate).not.toHaveBeenCalled()

    await owner.release('current')
    expect(keepAwake.deactivate).toHaveBeenLastCalledWith(tag)
  })

  it('recovers keep-awake on a later reacquire after a failed refresh', async () => {
    const owner = new MobileDictationKeepAwakeOwner()
    await owner.acquire('current')
    const tag = keepAwake.activate.mock.calls[0]?.[0]

    // Refresh loses the activation: deactivate succeeds, activate rejects.
    keepAwake.activate.mockRejectedValueOnce(new Error('Unable to activate keep awake'))
    await expect(owner.reacquire('current')).rejects.toThrow('Unable to activate keep awake')

    await owner.reacquire('current')
    expect(keepAwake.activate).toHaveBeenCalledTimes(3)
    expect(keepAwake.activate.mock.calls[2]?.[0]).toBe(tag)
    // Only the pre-refresh deactivate ran; recovery must not deactivate again.
    expect(keepAwake.deactivate).toHaveBeenCalledTimes(1)

    await owner.release('current')
    expect(keepAwake.deactivate).toHaveBeenLastCalledWith(tag)
  })

  it('records new-dictation intent even when previous-tag cleanup fails', async () => {
    const owner = new MobileDictationKeepAwakeOwner()
    await owner.acquire('first')

    // Release and its trailing drain both fail; the owner keeps stale intent.
    keepAwake.deactivate
      .mockRejectedValueOnce(new Error('Activity unavailable'))
      .mockRejectedValueOnce(new Error('Activity unavailable'))
    await expect(owner.release('first')).rejects.toThrow('Activity unavailable')

    // The next acquire's drain and previous-tag cleanup fail too, and the new
    // activation itself fails — intent must still be recorded for the heal.
    keepAwake.deactivate
      .mockRejectedValueOnce(new Error('Activity unavailable'))
      .mockRejectedValueOnce(new Error('Activity unavailable'))
    keepAwake.activate.mockRejectedValueOnce(new Error('Unable to activate keep awake'))
    await expect(owner.acquire('second')).rejects.toThrow('Unable to activate keep awake')

    await owner.reacquire('second')
    expect(keepAwake.activate).toHaveBeenCalledTimes(3)
    expect(keepAwake.activate.mock.calls.at(-1)?.[0]).toContain(':second')

    await owner.release('second')
  })

  it('keeps tracking a newer timed-out activation when an older one settles late', async () => {
    vi.useFakeTimers()
    try {
      const first = deferred()
      keepAwake.activate.mockImplementationOnce(() => first.promise)
      const owner = new MobileDictationKeepAwakeOwner()
      const acquire = owner.acquire('stacked')
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(MOBILE_DICTATION_KEEP_AWAKE_NATIVE_TIMEOUT_MS)
      await expect(acquire).rejects.toThrow('Keep-awake native call timed out')

      const second = deferred()
      keepAwake.activate.mockImplementationOnce(() => second.promise)
      const reacquire = owner.reacquire('stacked')
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(MOBILE_DICTATION_KEEP_AWAKE_NATIVE_TIMEOUT_MS)
      await expect(reacquire).rejects.toThrow('Keep-awake native call timed out')

      // The older activation settles late with a rejection; the newer
      // activation's tracking must survive it.
      first.reject(new Error('Activity unavailable'))
      await vi.advanceTimersByTimeAsync(0)

      await owner.release('stacked')
      // Exactly two: the reacquire's deactivate-first pass, plus the release
      // drain cleaning the newer entry the stale settle must not have deleted.
      expect(
        keepAwake.deactivate.mock.calls.filter(([tag]) => tag.includes(':stacked'))
      ).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reacquires a maybe-active timed-out activation by deactivating first', async () => {
    vi.useFakeTimers()
    try {
      keepAwake.activate.mockImplementationOnce(() => new Promise<void>(() => undefined))
      const owner = new MobileDictationKeepAwakeOwner()
      const acquire = owner.acquire('maybe')
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(MOBILE_DICTATION_KEEP_AWAKE_NATIVE_TIMEOUT_MS)
      await expect(acquire).rejects.toThrow('Keep-awake native call timed out')

      await owner.reacquire('maybe')
      // The ambiguous activation may be natively live; it must be deactivated
      // before the fresh activate so Android re-applies the window flag.
      const tag = keepAwake.activate.mock.calls[0]?.[0]
      expect(keepAwake.deactivate).toHaveBeenCalledWith(tag)
      expect(keepAwake.deactivate.mock.invocationCallOrder[0]).toBeLessThan(
        keepAwake.activate.mock.invocationCallOrder[1] ?? 0
      )

      await owner.release('maybe')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a live tag out of the orphan pool when a refresh deactivation fails', async () => {
    const ownerA = new MobileDictationKeepAwakeOwner()
    await ownerA.acquire('live')
    const liveTag = keepAwake.activate.mock.calls[0]?.[0]

    // Foreground refresh: the deactivate leg fails; the tag stays native-on
    // and the failure surfaces so the caller's bounded retry can kick in.
    keepAwake.deactivate.mockRejectedValueOnce(new Error('Activity unavailable'))
    await expect(ownerA.reacquire('live')).rejects.toThrow('Activity unavailable')
    expect(keepAwake.deactivate.mock.calls.filter(([tag]) => tag === liveTag)).toHaveLength(1)

    // Another owner's drain must spare the still-wanted live tag.
    const ownerB = new MobileDictationKeepAwakeOwner()
    await ownerB.acquire('other')
    expect(keepAwake.deactivate.mock.calls.filter(([tag]) => tag === liveTag)).toHaveLength(1)

    // The next foreground retries the full deactivate-then-activate refresh.
    await ownerA.reacquire('live')
    expect(keepAwake.activate.mock.calls.filter(([tag]) => tag === liveTag)).toHaveLength(2)

    await ownerA.release('live')
    await ownerB.release('other')
  })

  it('reacquires by deactivating before activating so Android re-applies the window flag', async () => {
    const owner = new MobileDictationKeepAwakeOwner()
    await owner.acquire('current')
    const tag = keepAwake.activate.mock.calls[0]?.[0]

    await owner.reacquire('current')

    expect(keepAwake.deactivate).toHaveBeenCalledWith(tag)
    expect(keepAwake.activate.mock.calls).toEqual([[tag], [tag]])
    expect(keepAwake.deactivate.mock.invocationCallOrder[0]).toBeLessThan(
      keepAwake.activate.mock.invocationCallOrder[1] ?? 0
    )

    await owner.reacquire('other')
    expect(keepAwake.activate).toHaveBeenCalledTimes(2)

    await owner.release('current')
  })
})
