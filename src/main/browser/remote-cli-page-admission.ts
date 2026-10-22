/**
 * One SSH host command's hold on a page. While it runs, every page sink (guest CDP sends, native
 * input, edit commands, the CDP proxy's intake) refuses work attributed to it once the host is
 * revoked. Work is attributed by async context: the command's own through its bridged scope, its
 * out-of-process helper's through the proxy message it arrived on. The hold also owns the
 * command's input cancel list: what it pressed and has not released, let go of on revocation.
 * A press that outlives its command (`mouse down`, then `mouse up` as another command) stays the
 * host's until anyone lets go of it or presses it again; if still the host's when its attachment
 * ends, it is let go of in the page's turn.
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
  /** Fires only when the host's attachment ends, never at one command's cancel. */
  hostRevoked?: AbortSignal
  /** Runs desktop-owned work in the page's command turn. */
  inPageTurn?: (work: () => Promise<void>) => Promise<unknown>
  /** Stops the command's helper, whose daemon outlives its killed client and keeps retrying. */
  retire?: () => Promise<void>
  releaseHeld?: (release: HeldInputRelease) => Promise<unknown>
}

type Admission = {
  admit: () => void
  /** Keyed by button, key or touch. */
  held: Map<string, HeldInputRelease>
  hooks: PageHoldHooks
}

type HostPress = { hostRevoked: AbortSignal; release: HeldInputRelease; hooks: PageHoldHooks }

const admissions = new Map<number, Admission>()
/** Per page, by input id: what a host pressed and nobody has let go of or pressed since. */
const hostPresses = new Map<number, Map<string, HostPress>>()
const watchedHosts = new WeakSet<AbortSignal>()
/** The hold a proxy message arrived under; its deferred steps keep it after the hold ends. */
const messageAdmission = new AsyncLocalStorage<Admission>()

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
  const admission: Admission = { admit, held: new Map(), hooks }
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
  return admission ? messageAdmission.run(admission, handle) : handle()
}

/** The page sinks' gate: throws for work of a revoked host's command; a no-op for the desktop's. */
export function assertRemoteCliPageAccess(webContentsId?: number): void {
  assertRemoteCliBrowserAccess(webContentsId)
  messageAdmission.getStore()?.admit()
}

/**
 * A host's read of the page: admitted as it starts and again as it answers, since the page can
 * move to a desktop-local document while the read is in flight. A no-op for the desktop's own.
 */
export async function readRemoteCliAdmittedPage<T>(
  webContentsId: number | undefined,
  read: () => Promise<T>
): Promise<T> {
  assertRemoteCliPageAccess(webContentsId)
  const result = await read()
  assertRemoteCliPageAccess(webContentsId)
  return result
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
  const input = params ? heldInput(method, params) : undefined
  if (webContentsId === undefined || !input) {
    return deliver()
  }
  // Why the message's hold first: a helper step can land after the command that queued it ended.
  const admission = messageAdmission.getStore() ?? admissions.get(webContentsId)
  if (input.release) {
    if (admission) {
      admission.held.set(input.id, input.release)
    }
    if (notePress(webContentsId, input.id, input.release, admission)) {
      return deliver()
    }
    // Why after delivery: a press that failed leaves the host's press in place, still the host's.
    return deliver().then((result) => {
      forgetHostPress(webContentsId, input.id)
      return result
    })
  }
  return deliver().then((result) => {
    admission?.held.delete(input.id)
    forgetHostPress(webContentsId, input.id)
    return result
  })
}

function notePress(
  webContentsId: number,
  id: string,
  release: HeldInputRelease,
  admission: Admission | undefined
): boolean {
  const { hostRevoked } = admission?.hooks ?? {}
  if (!admission || !hostRevoked || hostRevoked.aborted) {
    // False: the desktop's own press makes the input its own; letting go for the host would end it.
    return false
  }
  const presses = hostPresses.get(webContentsId) ?? new Map<string, HostPress>()
  presses.set(id, { hostRevoked, release, hooks: admission.hooks })
  hostPresses.set(webContentsId, presses)
  if (!watchedHosts.has(hostRevoked)) {
    watchedHosts.add(hostRevoked)
    hostRevoked.addEventListener('abort', () => letGoOfHostPresses(hostRevoked), { once: true })
  }
  return true
}

function forgetHostPress(webContentsId: number, id: string): void {
  const presses = hostPresses.get(webContentsId)
  presses?.delete(id)
  if (presses?.size === 0) {
    hostPresses.delete(webContentsId)
  }
}

function letGoOfHostPresses(hostRevoked: AbortSignal): void {
  for (const [webContentsId, presses] of hostPresses) {
    for (const [id, press] of presses) {
      const { inPageTurn, releaseHeld } = press.hooks
      if (press.hostRevoked !== hostRevoked || !releaseHeld) {
        continue
      }
      const letGo = async (): Promise<void> => {
        // Why recheck in the page's turn: a command that ran meanwhile may have made it its own.
        if (hostPresses.get(webContentsId)?.get(id) !== press) {
          return
        }
        forgetHostPress(webContentsId, id)
        await releaseAll(new Map([[id, press.release]]), releaseHeld)
      }
      // Why the direct fallback: a session torn down meanwhile rejects its queued work.
      void runOutsideRemoteCliBrowserScope(() =>
        (inPageTurn ? inPageTurn(letGo) : letGo()).catch(() => letGo())
      ).catch(() => {})
    }
  }
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

/** The input an event presses (`release` is how to let go of it) or lets go of (no `release`). */
function heldInput(
  method: string,
  params: Record<string, unknown>
): { id: string; release?: HeldInputRelease } | undefined {
  const type = params.type
  if (typeof type !== 'string') {
    return undefined
  }
  if (
    method === 'Input.dispatchMouseEvent' &&
    (type === 'mousePressed' || type === 'mouseReleased')
  ) {
    const id = `mouse:${String(params.button ?? 'left')}`
    // Why off the page: letting go there completes no click or drop the host had started.
    return type === 'mouseReleased'
      ? { id }
      : {
          id,
          release: {
            method,
            params: {
              type: 'mouseReleased',
              x: -1,
              y: -1,
              button: params.button ?? 'left',
              buttons: 0
            }
          }
        }
  }
  if (method === 'Input.dispatchKeyEvent' && ['keyDown', 'rawKeyDown', 'keyUp'].includes(type)) {
    const id = `key:${String(params.code ?? params.key ?? '')}`
    if (type === 'keyUp') {
      return { id }
    }
    const { key, code, windowsVirtualKeyCode, nativeVirtualKeyCode } = params
    return {
      id,
      release: {
        method,
        params: { type: 'keyUp', key, code, windowsVirtualKeyCode, nativeVirtualKeyCode }
      }
    }
  }
  if (method === 'Input.dispatchTouchEvent') {
    if (type === 'touchStart') {
      // Why cancel: a cancelled touch completes no tap the host had started.
      return { id: 'touch', release: { method, params: { type: 'touchCancel', touchPoints: [] } } }
    }
    if (type === 'touchEnd' || type === 'touchCancel') {
      return { id: 'touch' }
    }
  }
  return undefined
}
