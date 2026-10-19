/**
 * One SSH host command's hold on a page. While it runs, every page sink (guest CDP sends, native
 * input, edit commands, the CDP proxy's intake) refuses work attributed to it once the host is
 * revoked. Work is attributed by async context: the command's own through its bridged scope, its
 * out-of-process helper's through the proxy message it arrived on. The hold also owns the
 * command's input cancel list: what it pressed and has not released, let go of on revocation.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import {
  assertRemoteCliBrowserAccess,
  runOutsideRemoteCliBrowserScope
} from '../runtime/desktop-browser-bridge/remote-cli-browser-scope'

/** The CDP input event that lets go of something a command pressed. */
export type HeldInputRelease = { method: string; params: Record<string, unknown> }

export type PageHoldHooks = {
  /** Fires when the host is revoked; `retire` then runs at once, while the page is still held. */
  revoked?: AbortSignal
  /** Stops the command's helper, whose daemon outlives its killed client and keeps retrying. */
  retire?: () => Promise<void>
  releaseHeld?: (release: HeldInputRelease) => Promise<unknown>
}

type Admission = {
  admit: () => void
  /** Keyed by button, key or touch. */
  held: Map<string, HeldInputRelease>
}

const admissions = new Map<number, Admission>()
/** The hold a proxy message arrived under; its deferred steps keep it after the hold ends. */
const messageAdmission = new AsyncLocalStorage<() => void>()

/**
 * Runs a host's command holding the page. On revocation every later step is refused, releases
 * included, so once the command ends the desktop lets go of what it left held, from outside the
 * host's scope. A failure after revocation reports the revocation.
 */
export async function runWithRemoteCliPageAdmission<T>(
  webContentsId: number,
  admit: () => void,
  run: () => Promise<T>,
  hooks: PageHoldHooks = {}
): Promise<T> {
  const admission: Admission = { admit, held: new Map() }
  let retiring: Promise<void> | undefined
  const retire = (): Promise<void> | undefined =>
    hooks.retire && (retiring ??= runOutsideRemoteCliBrowserScope(hooks.retire))
  const onRevoked = (): void => void retire()
  hooks.revoked?.addEventListener('abort', onRevoked, { once: true })
  admissions.set(webContentsId, admission)
  try {
    try {
      return await run()
    } finally {
      hooks.revoked?.removeEventListener('abort', onRevoked)
      if (isRevoked(admit)) {
        await retire()
      }
      if (admissions.get(webContentsId) === admission) {
        admissions.delete(webContentsId)
      }
      const { releaseHeld } = hooks
      if (releaseHeld && admission.held.size > 0 && isRevoked(admit)) {
        await runOutsideRemoteCliBrowserScope(() => releaseAll(admission.held, releaseHeld))
      }
    }
  } catch (error) {
    admit()
    throw error
  }
}

/** Runs a proxy message's handling, deferred steps included, under the page's current hold. */
export function runUnderRemoteCliPageAdmission<T>(webContentsId: number, handle: () => T): T {
  const admission = admissions.get(webContentsId)
  return admission ? messageAdmission.run(admission.admit, handle) : handle()
}

/** The page sinks' gate: throws for work of a revoked host's command; a no-op for the desktop's. */
export function assertRemoteCliPageAccess(webContentsId?: number): void {
  assertRemoteCliBrowserAccess(webContentsId)
  messageAdmission.getStore()?.()
}

/**
 * Delivers one input event, recording it on the page's hold: a press counts as held once it may
 * have landed, a release only once it surely did.
 */
export function trackRemoteCliInput<T>(
  webContentsId: number | undefined,
  method: string,
  params: Record<string, unknown> | undefined,
  deliver: () => Promise<T>
): Promise<T> {
  const admission = webContentsId === undefined ? undefined : admissions.get(webContentsId)
  if (!admission || !params) {
    return deliver()
  }
  if (!['mouseReleased', 'keyUp', 'touchEnd', 'touchCancel'].includes(String(params.type))) {
    trackInput(admission, method, params)
    return deliver()
  }
  return deliver().then((result) => {
    trackInput(admission, method, params)
    return result
  })
}

function isRevoked(admit: () => void): boolean {
  try {
    admit()
    return false
  } catch {
    return true
  }
}

async function releaseAll(
  held: Map<string, HeldInputRelease>,
  releaseHeld: (release: HeldInputRelease) => Promise<unknown>
): Promise<void> {
  for (const release of held.values()) {
    try {
      await releaseHeld(release)
    } catch {
      // Best effort: the page may be gone, and nothing else is waiting on this release.
    }
  }
}

function trackInput(admission: Admission, method: string, params: Record<string, unknown>): void {
  const type = params.type
  if (typeof type !== 'string') {
    return
  }
  if (
    method === 'Input.dispatchMouseEvent' &&
    (type === 'mousePressed' || type === 'mouseReleased')
  ) {
    const id = `mouse:${String(params.button ?? 'left')}`
    if (type === 'mouseReleased') {
      admission.held.delete(id)
      return
    }
    // Why off the page: letting go there completes no click or drop the host had started.
    admission.held.set(id, {
      method,
      params: { type: 'mouseReleased', x: -1, y: -1, button: params.button ?? 'left', buttons: 0 }
    })
  } else if (
    method === 'Input.dispatchKeyEvent' &&
    ['keyDown', 'rawKeyDown', 'keyUp'].includes(type)
  ) {
    const id = `key:${String(params.code ?? params.key ?? '')}`
    if (type === 'keyUp') {
      admission.held.delete(id)
      return
    }
    const { key, code, windowsVirtualKeyCode, nativeVirtualKeyCode } = params
    admission.held.set(id, {
      method,
      params: { type: 'keyUp', key, code, windowsVirtualKeyCode, nativeVirtualKeyCode }
    })
  } else if (method === 'Input.dispatchTouchEvent' && type.startsWith('touch')) {
    if (type === 'touchStart') {
      // Why cancel: a cancelled touch completes no tap the host had started.
      admission.held.set('touch', { method, params: { type: 'touchCancel', touchPoints: [] } })
    } else if (type === 'touchEnd' || type === 'touchCancel') {
      admission.held.delete('touch')
    }
  }
}
