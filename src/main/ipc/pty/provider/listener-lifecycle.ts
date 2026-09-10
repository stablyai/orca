import type { WebContents } from 'electron'

// Why: localProvider.onData/onExit return unsubscribe functions. Without
// storing and calling these on re-registration, macOS app re-activation
// creates a new BrowserWindow and re-calls registerPtyHandlers, leaking
// duplicate listeners that forward every event twice.
export let localDataUnsub: (() => void) | null = null
export let localExitUnsub: (() => void) | null = null
export let localBackgroundStreamUnsub: (() => void) | null = null
export let localWriteUnavailableUnsub: (() => void) | null = null
export let didFinishLoadHandler: (() => void) | null = null
export let didFinishLoadWebContents: WebContents | null = null
export let rendererLifecycleResetWebContents: WebContents | null = null
export let rendererLifecycleResetHandler: (() => void) | null = null
// Why: the hidden-delivery gate registries mirror renderer state; a reload/crash destroys owners without unregistering, so they reset when the renderer is replaced (drop memory preserved).
export let rendererGateResetLoadHandler: (() => void) | null = null
export let rendererGateResetGoneHandler: (() => void) | null = null
export let rendererGateResetWebContents: WebContents | null = null
// Why: the backgrounded-delivery dedupe map lives in the registerPtyHandlers closure but teardown funnels through module-scope clearProviderPtyState.
// Why null-init + wrapper fn: see delivery/debug.ts — rolldown const-folds `export let fn = noop` bridges (STA-5661).
let clearBackgroundedDeliverySyncForPtyImpl: ((id: string) => void) | null = null

export function clearBackgroundedDeliverySyncForPty(id: string): void {
  clearBackgroundedDeliverySyncForPtyImpl?.(id)
}

export type RendererNavigationDetails = {
  isMainFrame: boolean
  isSameDocument: boolean
}

// Why: navigation details identify the triggering frame; querying aggregate load state can misclassify an overlapping subframe load.
export let rendererDidStartNavigationHandler:
  | ((details: RendererNavigationDetails) => void)
  | null = null

// Why: Restart daemon must re-bind provider→renderer listeners after replaceDaemonProvider swaps localProvider, else subscribers stay bound to the disposed adapter and new PTY data silently drops.
export let rebindProviderListeners: (() => void) | null = null
export let sshOutputIntakeCleanup: (() => void) | null = null

export function rebindLocalProviderListeners(): void {
  rebindProviderListeners?.()
}

export function setRebindProviderListeners(fn: (() => void) | null): void {
  rebindProviderListeners = fn
}

export function setClearBackgroundedDeliverySyncForPty(fn: (id: string) => void): void {
  clearBackgroundedDeliverySyncForPtyImpl = fn
}

export function setSshOutputIntakeCleanup(fn: (() => void) | null): void {
  sshOutputIntakeCleanup = fn
}

export function setLocalDataUnsub(fn: (() => void) | null): void {
  localDataUnsub = fn
}

export function setLocalExitUnsub(fn: (() => void) | null): void {
  localExitUnsub = fn
}

export function setLocalBackgroundStreamUnsub(fn: (() => void) | null): void {
  localBackgroundStreamUnsub = fn
}

export function setLocalWriteUnavailableUnsub(fn: (() => void) | null): void {
  localWriteUnavailableUnsub = fn
}

export function setDidFinishLoadHandler(
  handler: (() => void) | null,
  contents: WebContents | null
): void {
  didFinishLoadHandler = handler
  didFinishLoadWebContents = contents
}

export function setRendererLifecycleResetState(args: {
  contents: WebContents | null
  handler: (() => void) | null
  navigation: ((details: RendererNavigationDetails) => void) | null
}): void {
  rendererLifecycleResetWebContents = args.contents
  rendererLifecycleResetHandler = args.handler
  rendererDidStartNavigationHandler = args.navigation
}

export function setRendererGateResetState(args: {
  contents: WebContents | null
  load: (() => void) | null
  gone: (() => void) | null
}): void {
  rendererGateResetWebContents = args.contents
  rendererGateResetLoadHandler = args.load
  rendererGateResetGoneHandler = args.gone
}

// Why: Restart daemon must detach listeners AFTER synthetic pty:exit events fan out but BEFORE replaceDaemonProvider swaps the adapter; this export narrows that window to the caller.
export function unbindLocalProviderListeners(): void {
  localDataUnsub?.()
  localExitUnsub?.()
  localBackgroundStreamUnsub?.()
  localWriteUnavailableUnsub?.()
  localDataUnsub = null
  localExitUnsub = null
  localBackgroundStreamUnsub = null
  localWriteUnavailableUnsub = null
}
