import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake'

const MOBILE_DICTATION_KEEP_AWAKE_TAG_PREFIX = 'orca-mobile-dictation'

// Native keep-awake promises can be lost during Activity teardown; a bounded
// wait keeps the serialized queue below from wedging dictation until restart.
export const MOBILE_DICTATION_KEEP_AWAKE_NATIVE_TIMEOUT_MS = 10_000

let nextOwnerId = 0
let keepAwakeOperation: Promise<void> = Promise.resolve()
const activeTags = new Set<string>()
const pendingCleanupTags = new Set<string>()
// Timed-out activations that may still land natively, keyed to a predicate
// saying whether their dictation still wants the tag.
const pendingActivations = new Map<string, () => boolean>()

function createOwnerId(): string {
  nextOwnerId += 1
  return `${Date.now()}-${nextOwnerId}-${Math.random().toString(36).slice(2)}`
}

function enqueueKeepAwakeOperation(action: () => Promise<void>): Promise<void> {
  const operation = keepAwakeOperation.then(action)
  keepAwakeOperation = operation.catch(() => undefined)
  return operation
}

const KEEP_AWAKE_TIMEOUT_ERROR_NAME = 'KeepAwakeNativeTimeoutError'

function isNativeCallTimeout(err: unknown): boolean {
  return err instanceof Error && err.name === KEEP_AWAKE_TIMEOUT_ERROR_NAME
}

function withNativeCallTimeout(nativeCall: Promise<void>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      const timeoutError = new Error('Keep-awake native call timed out')
      timeoutError.name = KEEP_AWAKE_TIMEOUT_ERROR_NAME
      reject(timeoutError)
    }, MOBILE_DICTATION_KEEP_AWAKE_NATIVE_TIMEOUT_MS)
    nativeCall.then(
      () => {
        clearTimeout(timer)
        resolve()
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    )
  })
}

async function activateTrackedTag(tag: string, isStillWanted: () => boolean): Promise<void> {
  const nativeActivation = activateKeepAwakeAsync(tag)
  try {
    await withNativeCallTimeout(nativeActivation)
  } catch (err) {
    // Only a timeout is ambiguous: the activation can still take effect late.
    // A definite native rejection activated nothing and needs no cleanup.
    if (isNativeCallTimeout(err)) {
      // Tracked apart from deactivation retries so drains (including another
      // owner's) never turn off an activation its dictation still wants.
      pendingActivations.set(tag, isStillWanted)
      nativeActivation.then(
        () =>
          void enqueueKeepAwakeOperation(async () => {
            // Delete only this activation's own entry — a newer timed-out
            // activation of the same tag may have replaced it.
            if (pendingActivations.get(tag) === isStillWanted) {
              pendingActivations.delete(tag)
            }
            if (activeTags.has(tag)) {
              return
            }
            if (isStillWanted()) {
              // The activation landed late but its dictation is still live;
              // adopt it rather than turning off screen-lock protection.
              activeTags.add(tag)
              return
            }
            // No owner wants it anymore — the screen must not stay awake.
            await deactivateTrackedTag(tag).catch(() => undefined)
          }),
        () => {
          // A late definite rejection means nothing activated after all, but
          // spare a newer activation's entry keyed to the same tag.
          if (pendingActivations.get(tag) === isStillWanted) {
            pendingActivations.delete(tag)
          }
        }
      )
    }
    throw err
  }
  activeTags.add(tag)
  pendingCleanupTags.delete(tag)
  pendingActivations.delete(tag)
}

async function deactivateTrackedTag(tag: string): Promise<void> {
  try {
    await withNativeCallTimeout(deactivateKeepAwake(tag))
  } catch (err) {
    // A replacement hook must be able to retry cleanup after Android replaces
    // an Activity and the owner that acquired this tag has unmounted.
    pendingCleanupTags.add(tag)
    throw err
  }
  activeTags.delete(tag)
  pendingCleanupTags.delete(tag)
  pendingActivations.delete(tag)
}

async function cleanupPendingTags(): Promise<void> {
  const staleTags = new Set(pendingCleanupTags)
  for (const [tag, isStillWanted] of pendingActivations) {
    // A still-wanted timed-out activation is not an orphan: deactivating it
    // would turn off screen-lock protection for a live dictation.
    if (!isStillWanted()) {
      pendingActivations.delete(tag)
      staleTags.add(tag)
    }
  }
  if (staleTags.size === 0) {
    return
  }
  // Retry concurrently so N stale tags cost one timeout window, not N, and
  // swallow failures: a stale tag that still cannot be deactivated must not
  // fail the fresh acquire that triggered this retry; it stays queued.
  await Promise.allSettled(
    Array.from(staleTags, (tag) => deactivateTrackedTag(tag).catch(() => undefined))
  )
}

export class MobileDictationKeepAwakeOwner {
  private readonly ownerId = createOwnerId()
  private acquiredTag: string | null = null

  acquire(dictationId: string): Promise<void> {
    const tag = this.createTag(dictationId)
    return enqueueKeepAwakeOperation(async () => {
      await cleanupPendingTags()
      if (this.acquiredTag && !activeTags.has(this.acquiredTag)) {
        this.acquiredTag = null
      }
      if (this.acquiredTag === tag) {
        return
      }
      if (this.acquiredTag) {
        const previousTag = this.acquiredTag
        this.acquiredTag = null
        // Best-effort: a failed previous-tag cleanup is queued for retry and
        // must not block recording intent for the new dictation below.
        await deactivateTrackedTag(previousTag).catch(() => undefined)
      }
      // Record ownership before the native call: acquiredTag is intent while
      // activeTags is native state, so a failed initial activation can still
      // be healed by a later foreground reacquire.
      this.acquiredTag = tag
      await activateTrackedTag(tag, () => this.acquiredTag === tag)
    })
  }

  // Android keeps FLAG_KEEP_SCREEN_ON on the Activity window, so a recreated
  // Activity silently loses it while native tags persist — and native activate
  // skips re-applying the flag while any tag remains, so deactivate first.
  reacquire(dictationId: string): Promise<void> {
    const tag = this.createTag(dictationId)
    return enqueueKeepAwakeOperation(async () => {
      await cleanupPendingTags()
      if (this.acquiredTag !== tag) {
        return
      }
      // A timed-out activation may be natively active too, and Android only
      // re-applies the window flag from an empty tag set — deactivate both.
      if (activeTags.has(tag) || pendingActivations.has(tag)) {
        try {
          await deactivateTrackedTag(tag)
        } catch (err) {
          // A still-live tag must not sit in the orphan pool where another
          // owner's drain would turn it off without reactivating; keep it in
          // the wanted pool and surface the failure so the caller can retry
          // before the next foreground event.
          pendingCleanupTags.delete(tag)
          pendingActivations.set(tag, () => this.acquiredTag === tag)
          throw err
        }
      }
      // Also recovers an activation lost to an earlier native failure, so a
      // later foreground event can restore keep-awake instead of no-oping.
      // Known gap: if another expo-keep-awake owner exists (e.g. dev-build
      // dev tools), the native module never empties its tag set, so the
      // deactivate/activate cycle cannot re-apply the Android window flag.
      await activateTrackedTag(tag, () => this.acquiredTag === tag)
    })
  }

  release(dictationId?: string): Promise<void> {
    const targetTag = dictationId ? this.createTag(dictationId) : null
    return enqueueKeepAwakeOperation(async () => {
      try {
        const tag = this.acquiredTag
        if (!tag || (targetTag && tag !== targetTag)) {
          return
        }
        if (!activeTags.has(tag)) {
          this.acquiredTag = null
          return
        }
        await deactivateTrackedTag(tag)
        this.acquiredTag = null
      } finally {
        // Drain after the owner-local unset so this owner's own timed-out
        // activation is no longer wanted and gets cleaned here — an acquire
        // may never happen again this session. Still-wanted tags of other
        // live dictations are spared by the drain itself.
        await cleanupPendingTags()
      }
    })
  }

  private createTag(dictationId: string): string {
    return `${MOBILE_DICTATION_KEEP_AWAKE_TAG_PREFIX}:${this.ownerId}:${dictationId}`
  }
}

export function createMobileDictationKeepAwakeOwner(): MobileDictationKeepAwakeOwner {
  return new MobileDictationKeepAwakeOwner()
}

// Foreground is the retry point for wake tags whose final deactivation timed
// out after a dictation ended — otherwise nothing runs until the next one.
export function drainMobileDictationKeepAwakeCleanup(): Promise<void> {
  return enqueueKeepAwakeOperation(cleanupPendingTags)
}
