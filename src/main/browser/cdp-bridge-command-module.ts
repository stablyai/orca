import type { WebContents } from 'electron'
import type { BrowserScreenshotResult, BrowserScrollResult } from '../../shared/runtime-types'
import type { CdpTabState } from './cdp-auxiliary-commands'
import type { CdpCommandSender, RefEntry } from './snapshot-engine'
import type { CdpBridgeState, CdpQueuedCommand } from './cdp-bridge-state'
import type { CdpDebuggerLifecycle } from './cdp-debugger-lifecycle'
import type { CdpNavigationOperations } from './cdp-navigation-operations'
import type { CdpRefResolution } from './cdp-ref-resolution'

export type CdpScrollDirection = BrowserScrollResult extends { scrolled: infer Direction }
  ? Direction
  : never
export type CdpScreenshotFormat = BrowserScreenshotResult extends { format: infer Format }
  ? Format
  : never

export abstract class CdpBridgeCommandModule {
  constructor(
    private readonly bridgeState: CdpBridgeState,
    private readonly debuggerLifecycle: CdpDebuggerLifecycle,
    private readonly refResolution: CdpRefResolution,
    private readonly navigation: CdpNavigationOperations
  ) {}

  protected get activeWebContentsId(): number | null {
    return this.bridgeState.activeWebContentsId
  }

  protected set activeWebContentsId(webContentsId: number | null) {
    this.bridgeState.activeWebContentsId = webContentsId
  }

  protected get tabState(): Map<string, CdpTabState> {
    return this.bridgeState.tabState
  }

  protected get commandQueues(): Map<string, CdpQueuedCommand[]> {
    return this.bridgeState.commandQueues
  }

  protected getActiveGuest(): WebContents {
    return this.bridgeState.getActiveGuest()
  }

  protected getRegisteredTabs(): Map<string, number> {
    return this.bridgeState.getRegisteredTabs()
  }

  protected resolveTabId(webContentsId: number): string {
    return this.bridgeState.resolveTabId(webContentsId)
  }

  protected resolveTabIdSafe(webContentsId: number): string | null {
    return this.bridgeState.resolveTabIdSafe(webContentsId)
  }

  protected getOrCreateTabState(tabId: string): CdpTabState {
    return this.bridgeState.getOrCreateTabState(tabId)
  }

  protected removeDebuggerListeners(guest: WebContents, state: CdpTabState): void {
    this.debuggerLifecycle.removeDebuggerListeners(guest, state)
  }

  protected ensureDebuggerAttached(guest: WebContents): Promise<void> {
    return this.debuggerLifecycle.ensureDebuggerAttached(guest)
  }

  protected makeCdpSender(guest: WebContents, sessionId?: string): CdpCommandSender {
    return this.debuggerLifecycle.makeCdpSender(guest, sessionId)
  }

  protected senderForRef(guest: WebContents, ref: RefEntry): CdpCommandSender {
    return this.refResolution.senderForRef(guest, ref)
  }

  protected resolveRef(
    guest: WebContents,
    sender: CdpCommandSender,
    ref: string
  ): Promise<RefEntry> {
    return this.refResolution.resolveRef(guest, sender, ref)
  }

  protected scrollIntoView(sender: CdpCommandSender, backendNodeId: number): Promise<void> {
    return this.refResolution.scrollIntoView(sender, backendNodeId)
  }

  protected getElementCenter(
    sender: CdpCommandSender,
    backendNodeId: number
  ): Promise<{ cx: number; cy: number }> {
    return this.refResolution.getElementCenter(sender, backendNodeId)
  }

  protected getPageCoordinates(
    guest: WebContents,
    refEntry: RefEntry,
    localCx: number,
    localCy: number
  ): Promise<{ cx: number; cy: number }> {
    return this.refResolution.getPageCoordinates(guest, refEntry, localCx, localCy)
  }

  protected getNavigationId(sender: CdpCommandSender): Promise<string> {
    return this.navigation.getNavigationId(sender)
  }

  protected getPreviousHistoryEntryId(sender: CdpCommandSender): Promise<number> {
    return this.navigation.getPreviousHistoryEntryId(sender)
  }

  protected waitForLoad(sender: CdpCommandSender, guest: WebContents): Promise<void> {
    return this.navigation.waitForLoad(sender, guest)
  }

  protected waitForNetworkIdle(
    guest: WebContents,
    timeoutMs: number,
    idleMs: number
  ): Promise<void> {
    return this.navigation.waitForNetworkIdle(guest, timeoutMs, idleMs)
  }

  protected invalidateRefMap(webContentsId: number): void {
    this.bridgeState.invalidateRefMap(webContentsId)
  }

  protected enqueueCommand<T>(execute: () => Promise<T>): Promise<T> {
    return this.bridgeState.enqueueCommand(execute)
  }
}
