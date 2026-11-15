/** One load into a profile session; it checks `cancelled` after each step. */
export type BrowserExtensionProfileLoad = {
  extensionId: string
  cancelled: boolean
  settled: Promise<void>
}

export const BROWSER_EXTENSION_PROFILE_UNAVAILABLE =
  'Browser profile is not available for extensions'

export function throwIfBrowserExtensionLoadCancelled(load: BrowserExtensionProfileLoad): void {
  if (load.cancelled) {
    throw new Error('The extension was turned off before it finished loading')
  }
}

/**
 * Every load into one profile session runs through here, so an unload can cancel it and a detach
 * can wait for it before purging the profile. Loads of one extension run one after another.
 */
export class BrowserExtensionProfileLoads {
  private readonly loads = new Set<BrowserExtensionProfileLoad>()
  private closed = false

  track<T>(
    extensionId: string,
    run: (load: BrowserExtensionProfileLoad) => Promise<T>
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error(BROWSER_EXTENSION_PROFILE_UNAVAILABLE))
    }
    const earlier = [...this.loads]
      .filter((load) => load.extensionId === extensionId)
      .map((load) => load.settled)
    const load: BrowserExtensionProfileLoad = {
      extensionId,
      cancelled: false,
      settled: Promise.resolve()
    }
    const running = Promise.all(earlier).then(() => run(load))
    load.settled = running.then(
      () => undefined,
      () => undefined
    )
    this.loads.add(load)
    void load.settled.then(() => this.loads.delete(load))
    return running
  }

  /** Cancels the loads of one extension, or all with null; resolves once they have stopped. */
  cancel(extensionId: string | null): Promise<unknown> {
    const cancelled = [...this.loads].filter(
      (load) => extensionId === null || load.extensionId === extensionId
    )
    for (const load of cancelled) {
      load.cancelled = true
    }
    return Promise.all(cancelled.map((load) => load.settled))
  }

  /** Refuses new loads and cancels the rest; resolves once they have stopped. */
  close(): Promise<unknown> {
    this.closed = true
    return this.cancel(null)
  }
}
