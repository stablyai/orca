/** Attribute page work to its host command and release host-owned input when access ends. */
import { AsyncLocalStorage } from 'node:async_hooks'
import {
  assertRemoteCliBrowserAccess,
  runOutsideRemoteCliBrowserScope
} from '../runtime/desktop-browser-bridge/remote-cli-browser-scope'

export type HeldInputRelease = { method: string; params: Record<string, unknown> }

export type PageHoldHooks = {
  /** Abort immediately retires the helper while admission is still held. */
  revoked?: AbortSignal
  /** Attachment revocation, independent of individual command cancellation. */
  hostRevoked?: AbortSignal
  inPageTurn?: (work: () => Promise<void>) => Promise<unknown>
  /** Retire the daemon too: killing its helper client does not stop its retries. */
  retire?: () => Promise<void>
  releaseHeld?: (release: HeldInputRelease) => Promise<unknown>
}

type Admission = {
  admit: () => void
  held: Map<string, HeldInputRelease>
  hooks: PageHoldHooks
}

type HostPress = { hostRevoked: AbortSignal; release: HeldInputRelease; hooks: PageHoldHooks }

const admissions = new Map<number, Admission>()
/** Per-page input stays host-owned until released or pressed again by another caller. */
const hostPresses = new Map<number, Map<string, HostPress>>()
const watchedHosts = new WeakSet<AbortSignal>()
/** Deferred proxy steps retain the admission active when their message arrived. */
const messageAdmission = new AsyncLocalStorage<Admission>()

/** Refuse revoked host work, then retire its helper and release held input outside its scope. */
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

/** Attribute deferred proxy work to the page's current admission. */
export function runUnderRemoteCliPageAdmission<T>(webContentsId: number, handle: () => T): T {
  const admission = admissions.get(webContentsId)
  return admission ? messageAdmission.run(admission, handle) : handle()
}

/** Reject revoked host work; desktop-owned work remains admitted. */
export function assertRemoteCliPageAccess(webContentsId?: number): void {
  assertRemoteCliBrowserAccess(webContentsId)
  messageAdmission.getStore()?.admit()
}

/** Recheck after reads: the page may navigate to a desktop-local document while awaiting results. */
export async function readRemoteCliAdmittedPage<T>(
  webContentsId: number | undefined,
  read: () => Promise<T>
): Promise<T> {
  assertRemoteCliPageAccess(webContentsId)
  const result = await read()
  assertRemoteCliPageAccess(webContentsId)
  return result
}

/** Record presses before delivery and releases only after confirmed delivery. */
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
  // Deferred helper work must retain its original admission after the command ends.
  const admission = messageAdmission.getStore() ?? admissions.get(webContentsId)
  if (input.release) {
    if (admission) {
      admission.held.set(input.id, input.release)
    }
    if (notePress(webContentsId, input.id, input.release, admission)) {
      return deliver()
    }
    // A failed desktop press must not transfer ownership of the host's held input.
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
    // A successful desktop press transfers ownership, so host cleanup must not release it.
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
        // A queued command may have transferred ownership before this cleanup runs.
        if (hostPresses.get(webContentsId)?.get(id) !== press) {
          return
        }
        forgetHostPress(webContentsId, id)
        await releaseAll(new Map([[id, press.release]]), releaseHeld)
      }
      // Teardown can reject queued cleanup; fall back to direct release.
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
      // The page may already be gone; continue releasing other held input.
    }
  }
}

/** A press carries its release event; a release carries only the input ID. */
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
    // Release off-page to avoid completing the revoked click or drop.
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
      // Cancel avoids completing a tap from the revoked host.
      return { id: 'touch', release: { method, params: { type: 'touchCancel', touchPoints: [] } } }
    }
    if (type === 'touchEnd' || type === 'touchCancel') {
      return { id: 'touch' }
    }
  }
  return undefined
}
