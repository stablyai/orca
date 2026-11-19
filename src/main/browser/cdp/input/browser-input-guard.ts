import { randomUUID } from 'node:crypto'
import type { WebContents, WebFrameMain } from 'electron'
import {
  BROWSER_INPUT_GUARD,
  BROWSER_INPUT_GUARD_ACK
} from '../../../../shared/browser/element-grab/browser-input-guard'

type BrowserInputOwner = Pick<WebContents, 'id'>

type PendingGuard = {
  suspended: boolean
  promise: Promise<void>
  resend: (revision: number) => void
  cancel: () => void
}
type Guard = {
  guest: WebContents
  token: string
  revision: number
  suspended: boolean
  nativeToken: string | null
  chordToken: string | null
  pending?: PendingGuard
}
const guards = new WeakMap<BrowserInputOwner, Guard>()

/** The guard covers all private policies, including one whose main-side callback retired. */
export function setBrowserInputGuard(target: BrowserInputOwner, suspended: boolean): Promise<void> {
  const guard = guards.get(target)
  if (!guard) {
    return Promise.resolve()
  }
  const guest = guard.guest
  guard.suspended = suspended
  const revision = ++guard.revision
  if (guard.pending?.suspended === suspended) {
    const pending = guard.pending
    pending.resend(revision)
    return pending.promise
  }
  guard.pending?.cancel()
  let frame: WebFrameMain | null = null
  let expectedRevision = revision
  let finish: (ready: boolean) => void = () => {}
  const cancel = (): void => finish(false)
  const report = (
    event: Electron.IpcMainEvent,
    channel: string,
    payload: { token?: string; revision?: number; suspended?: boolean }
  ): void => {
    if (
      channel === BROWSER_INPUT_GUARD_ACK &&
      event.senderFrame === frame &&
      guest.mainFrame === frame &&
      payload?.token === guard.token &&
      payload.revision === expectedRevision &&
      payload.suspended === suspended
    ) {
      finish(true)
    }
  }
  const promise = new Promise<void>((resolve, reject) => {
    let finished = false
    const timer = setTimeout(cancel, 1_000)
    finish = (ready) => {
      if (finished) {
        return
      }
      finished = true
      clearTimeout(timer)
      guest.off('ipc-message', report)
      guest.off('destroyed', cancel)
      if (guard.pending?.cancel === cancel) {
        guard.pending = undefined
      }
      if (ready) {
        resolve()
      } else {
        reject(new Error('Browser input guard unavailable'))
      }
    }
    guest.on('ipc-message', report)
    guest.once('destroyed', cancel)
  })
  const pending: PendingGuard = {
    suspended,
    promise,
    cancel,
    resend: (nextRevision) => {
      try {
        frame = guest.mainFrame
        expectedRevision = nextRevision
        frame.send(BROWSER_INPUT_GUARD, {
          token: guard.token,
          revision: nextRevision,
          suspended,
          nativeToken: guard.nativeToken,
          chordToken: guard.chordToken
        })
      } catch {
        finish(false)
      }
    }
  }
  guard.pending = pending
  pending.resend(revision)
  return promise
}

export function hasBrowserInputGuard(guest: BrowserInputOwner): boolean {
  return guards.has(guest)
}

export function setBrowserInputPolicy(
  guest: WebContents,
  kind: 'native' | 'chord',
  token: string | null
): void {
  let guard = guards.get(guest)
  if (!guard) {
    guard = {
      guest,
      token: randomUUID(),
      revision: 0,
      suspended: true,
      nativeToken: null,
      chordToken: null
    }
    guards.set(guest, guard)
  }
  guard[kind === 'native' ? 'nativeToken' : 'chordToken'] = token
  void setBrowserInputGuard(guest, guard.suspended).catch(() => {})
}

export function retireBrowserInputPolicy(
  guest: WebContents,
  kind: 'native' | 'chord',
  token: string
): void {
  if (guards.get(guest)?.[kind === 'native' ? 'nativeToken' : 'chordToken'] === token) {
    setBrowserInputPolicy(guest, kind, null)
  }
}
