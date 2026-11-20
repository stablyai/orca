import type { WebContents } from 'electron'

type ScriptGuest = Pick<WebContents, 'isDestroyed' | 'on' | 'off'>
const executing = new WeakSet<ScriptGuest>()

/** A stalled script retains its admission slot until it settles; retries cannot accumulate page work. */
export function executeGrabScript(
  guest: ScriptGuest,
  execute: () => Promise<unknown>,
  timeoutMs = 2_000
): Promise<boolean> {
  if (guest.isDestroyed() || executing.has(guest)) {
    return Promise.resolve(false)
  }
  executing.add(guest)
  return new Promise((resolve) => {
    let settled = false
    const finish = (success: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      guest.off('destroyed', fail)
      guest.off('did-start-navigation', onNavigation)
      resolve(success)
    }
    const fail = (): void => finish(false)
    const onNavigation = (
      _event: unknown,
      _url: unknown,
      isInPlace: boolean,
      isMainFrame: boolean
    ): void => {
      if (isMainFrame && !isInPlace) {
        fail()
      }
    }
    const timer = setTimeout(fail, timeoutMs)
    guest.on('destroyed', fail)
    guest.on('did-start-navigation', onNavigation)
    try {
      void execute().then(
        (result) => {
          executing.delete(guest)
          finish(result === true)
        },
        () => {
          executing.delete(guest)
          fail()
        }
      )
    } catch {
      executing.delete(guest)
      fail()
    }
  })
}
