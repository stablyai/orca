import { wakelockSetParamsSchema } from '../mobile-web-shell/bridge/bridge-audio-verbs'

/**
 * The device side of `native.wakelock.set`, on the shell where `expo-keep-awake` exists.
 *
 * Dictation holds the screen awake from the moment recording starts until the transcript is back,
 * because a screen lock mid-processing suspends the app and loses it. On the page that tag has to
 * be asked for, which is this verb; natively the same seam calls `expo-keep-awake` directly.
 *
 * The shell tracks what it is holding for two reasons. A page that releases a tag it never took
 * asks the device nothing, because `deactivateKeepAwake` on an unheld tag is a native call whose
 * failure would read to the page as a wake lock it could not drop. And a page session that ends
 * with a tag still held has it given back for it — the page is a document that can navigate, fault
 * or be swiped away mid-dictation, and nothing else would ever call `deactivate`, so the screen
 * would stay awake for the app's lifetime.
 *
 * So the set means "the device still has this tag", not "the page asked for it": a deactivation the
 * device refused leaves the tag recorded, because the page's owner queues exactly that failure for
 * a retry and the retry has to reach the device.
 */
export type WakelockDevice = {
  readonly activate: (tag: string) => Promise<void>
  readonly deactivate: (tag: string) => Promise<void>
}

export type NativeWakelockServer = {
  readonly serve: (params: unknown) => Promise<{ active: boolean }>
  /** Gives back every tag this session still holds. The page session's end and the screen's
   *  unmount both call it, exactly as they do for a staged media handle and a live microphone. */
  readonly dispose: () => void
}

export function createNativeWakelockServer(device: WakelockDevice): NativeWakelockServer {
  const held = new Set<string>()
  /**
   * One chain per tag, because `held` is read and written across an await.
   *
   * A release that arrives while its own activate is still in flight would otherwise read the set
   * before the activate had recorded anything, find nothing, deactivate nothing and report the tag
   * off — and then the activate lands and the device holds a tag the page has already said it does
   * not want. Per tag rather than one chain for the server: a device call that hangs on one
   * dictation's tag must not hold up another's.
   */
  const queues = new Map<string, Promise<unknown>>()
  let disposed = false

  function enqueue<Value>(tag: string, action: () => Promise<Value>): Promise<Value> {
    const previous = queues.get(tag) ?? Promise.resolve()
    // On both settle paths: an activate the device refused must not wedge every later release.
    const run = previous.then(action, action)
    const settled = run.then(
      () => undefined,
      () => undefined
    )
    queues.set(tag, settled)
    void settled.then(() => {
      // Dropped once nothing is behind it, so a screen's worth of dictations does not accumulate.
      if (queues.get(tag) === settled) {
        queues.delete(tag)
      }
    })
    return run
  }

  async function set(active: boolean, tag: string): Promise<{ active: boolean }> {
    if (active) {
      await device.activate(tag)
      // Recorded the moment the device has it, before anything else here can fail. The set means
      // "the device still has this tag", and the compensating release below is the one path that
      // could leave a tag on with nothing recorded.
      held.add(tag)
      if (!disposed) {
        return { active: true }
      }
      // The session can end between the call and its reply — the page is a document that can be
      // swiped away mid-dictation — and a tag recorded after that dispose is held by nobody:
      // `dispose` has already walked the set and nothing will walk it again. So it is given back
      // here instead, and the page is told it is not held. A refusal rejects rather than reporting
      // a tag the device still holds as free, which is what lets the caller's retry path run.
      await device.deactivate(tag)
      held.delete(tag)
      return { active: false }
    }
    if (held.has(tag)) {
      // Deleted only once the device has really dropped it. A refusal rejects out of here, which
      // is how the page's owner learns to queue a retry — and that retry arrives as another
      // `active: false`, so the tag has to still be recorded or it would answer "not held"
      // without calling anything and leave the native tag on for the life of the app.
      await device.deactivate(tag)
      held.delete(tag)
    }
    return { active: false }
  }

  return {
    // Parsed before the queue, so a malformed request is refused rather than waiting behind a tag.
    serve: async (params) => {
      const { active, tag } = wakelockSetParamsSchema.parse(params)
      return await enqueue(tag, () => set(active, tag))
    },
    dispose: () => {
      disposed = true
      for (const tag of Array.from(held)) {
        // Quiet, for the reason every other dispose here is: this runs while a screen is going
        // away, and a device that would not drop a tag is not something the page can be told about.
        // Forgotten only on success, so one this device refused stays recorded and a later release
        // still reaches it. Queued behind that tag's own operations rather than racing them, and
        // re-reading the set once it runs: a release already in flight may have given it back, and
        // deactivating an unheld tag is a native call this module does not make.
        void enqueue(tag, async () => {
          if (!held.has(tag)) {
            return
          }
          await device.deactivate(tag)
          held.delete(tag)
        }).catch(() => undefined)
      }
    }
  }
}
