import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { notifyLocalPtyProviderRebound } from './local-provider-rebound'
import type { PtyRendererDelivery } from '../session'

// Re-registration must unsubscribe old provider listeners or macOS window reactivation forwards events twice.
export let localDataUnsub: (() => void) | null = null
export let localExitUnsub: (() => void) | null = null
export let localBackgroundStreamUnsub: (() => void) | null = null
export let localWriteUnavailableUnsub: (() => void) | null = null
export let didFinishLoadHandler: (() => void) | null = null
export let didFinishLoadWebContents: PtyRendererDelivery['webContents'] | null = null
export let rendererLifecycleResetWebContents: PtyRendererDelivery['webContents'] | null = null
export let rendererLifecycleResetHandler: (() => void) | null = null
// Renderer replacement resets abandoned marks/interest while preserving unrestored drop memory.
export let rendererGateResetLoadHandler: (() => void) | null = null
export let rendererGateResetGoneHandler: (() => void) | null = null
export let rendererGateResetWebContents: PtyRendererDelivery['webContents'] | null = null
// Module cleanup reaches closure-owned pacing state; null-initialized wrappers avoid Rolldown no-op folding (STA-5661).
let clearBackgroundedDeliverySyncForPtyImpl: ((id: string) => void) | null = null

export function clearBackgroundedDeliverySyncForPty(id: string): void {
  clearBackgroundedDeliverySyncForPtyImpl?.(id)
}

export type RendererNavigationDetails = {
  isMainFrame: boolean
  isSameDocument: boolean
}

// Use navigation frame details; aggregate load state can confuse overlapping subframes.
export let rendererDidStartNavigationHandler:
  | ((details: RendererNavigationDetails) => void)
  | null = null

// Provider replacement must rebind listeners or output stays attached to the disposed adapter.
export let rebindProviderListeners: (() => void) | null = null

export function rebindLocalProviderListeners(): void {
  rebindProviderListeners?.()
  if (ORCA_LAYOUT_OWNER_IS_MAIN) {
    notifyLocalPtyProviderRebound()
  }
}

export function setRebindProviderListeners(fn: (() => void) | null): void {
  rebindProviderListeners = fn
}

export function setClearBackgroundedDeliverySyncForPty(fn: (id: string) => void): void {
  clearBackgroundedDeliverySyncForPtyImpl = fn
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
  contents: PtyRendererDelivery['webContents'] | null
): void {
  didFinishLoadHandler = handler
  didFinishLoadWebContents = contents
}

export function setRendererLifecycleResetState(args: {
  contents: PtyRendererDelivery['webContents'] | null
  handler: (() => void) | null
  navigation: ((details: RendererNavigationDetails) => void) | null
}): void {
  rendererLifecycleResetWebContents = args.contents
  rendererLifecycleResetHandler = args.handler
  rendererDidStartNavigationHandler = args.navigation
}

export function setRendererGateResetState(args: {
  contents: PtyRendererDelivery['webContents'] | null
  load: (() => void) | null
  gone: (() => void) | null
}): void {
  rendererGateResetWebContents = args.contents
  rendererGateResetLoadHandler = args.load
  rendererGateResetGoneHandler = args.gone
}

// Detach after synthetic exits fan out and before replacing the adapter.
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
