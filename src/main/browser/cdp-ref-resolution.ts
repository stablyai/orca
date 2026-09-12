import type { WebContents } from 'electron'
import { BrowserError } from './browser-error'
import type { CdpTabState } from './cdp-auxiliary-commands'
import type { CdpCommandSender, RefEntry } from './snapshot-engine'
import type { CdpBridgeState } from './cdp-bridge-state'
import type { CdpDebuggerLifecycle } from './cdp-debugger-lifecycle'
import type { CdpNavigationOperations } from './cdp-navigation-operations'
import type {
  CdpElementActionability,
  ElementActionabilityRequirements
} from './cdp-element-actionability'

export class CdpRefResolution {
  constructor(
    private readonly bridgeState: CdpBridgeState,
    private readonly debuggerLifecycle: CdpDebuggerLifecycle,
    private readonly navigation: CdpNavigationOperations,
    private readonly actionability: CdpElementActionability
  ) {}

  senderForRef(guest: WebContents, ref: RefEntry): CdpCommandSender {
    return ref.sessionId ? this.makeCdpSender(guest, ref.sessionId) : this.makeCdpSender(guest)
  }

  async resolveRef(guest: WebContents, sender: CdpCommandSender, ref: string): Promise<RefEntry> {
    const tabId = this.resolveTabId(guest.id)
    const state = this.getOrCreateTabState(tabId)

    if (!state.snapshotResult) {
      throw new BrowserError(
        'browser_stale_ref',
        "No snapshot exists for this tab. Run 'orca snapshot' first."
      )
    }

    const entry = state.snapshotResult.refMap.get(ref)
    if (!entry) {
      throw new BrowserError(
        'browser_ref_not_found',
        `Element ref ${ref} was not found. Run 'orca snapshot' to see available refs.`
      )
    }

    // Why: iframe refs use a child session with independent nav history, so a parent-navId check would falsely reject them.
    if (!entry.sessionId) {
      const currentNavId = await this.getNavigationId(sender)
      if (state.navigationId && currentNavId !== state.navigationId) {
        state.snapshotResult = null
        state.navigationId = null
        throw new BrowserError(
          'browser_stale_ref',
          "The page has navigated since the last snapshot. Run 'orca snapshot' to get fresh refs."
        )
      }
    }

    const refSender = entry.sessionId ? this.makeCdpSender(guest, entry.sessionId) : sender
    try {
      await refSender('DOM.describeNode', { backendNodeId: entry.backendDOMNodeId })
      return entry
    } catch {
      // Why: dynamic pages re-render nodes, detaching snapshot refs; re-query the AX tree by role+name for the fresh node.
      const recovered = await this.tryRecoverRef(refSender, entry)
      if (recovered) {
        entry.backendDOMNodeId = recovered
        return entry
      }
      state.snapshotResult = null
      throw new BrowserError(
        'browser_stale_ref',
        `Element ${ref} no longer exists in the DOM. Run 'orca snapshot' to get fresh refs.`
      )
    }
  }

  async scrollIntoView(sender: CdpCommandSender, backendNodeId: number): Promise<void> {
    const { nodeId } = (await sender('DOM.requestNode', { backendNodeId })) as { nodeId: number }
    const { object } = (await sender('DOM.resolveNode', { nodeId })) as {
      object: { objectId: string }
    }
    await sender('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function() { this.scrollIntoView({ block: 'center', inline: 'center' }); }`
    })
  }

  assertElementInteractable(
    sender: CdpCommandSender,
    backendNodeId: number,
    ref: string,
    requirements?: ElementActionabilityRequirements
  ): Promise<void> {
    return this.actionability.assertElementInteractable(sender, backendNodeId, ref, requirements)
  }

  getElementCenter(
    sender: CdpCommandSender,
    backendNodeId: number,
    ref?: string
  ): Promise<{ cx: number; cy: number }> {
    return this.actionability.getElementCenter(sender, backendNodeId, ref)
  }

  // Why: Input.dispatchMouseEvent uses parent-page coords, so project iframe-local points through each parent surface.
  getPageCoordinates(
    guest: WebContents,
    refEntry: RefEntry,
    localCx: number,
    localCy: number
  ): Promise<{ cx: number; cy: number }> {
    return this.actionability.getPageCoordinates(guest, refEntry, localCx, localCy)
  }

  // Why: nth-index disambiguates duplicate role+name matches so recovery hits the original element, not the first match.
  private async tryRecoverRef(sender: CdpCommandSender, entry: RefEntry): Promise<number | null> {
    try {
      const { nodes } = (await sender('Accessibility.getFullAXTree')) as {
        nodes: { role?: { value: string }; name?: { value: string }; backendDOMNodeId?: number }[]
      }
      const matches: number[] = []
      for (const node of nodes) {
        if (
          node.role?.value === entry.role &&
          node.name?.value === entry.name &&
          node.backendDOMNodeId
        ) {
          matches.push(node.backendDOMNodeId)
        }
      }

      const targetIndex = (entry.nth ?? 1) - 1
      const candidates = targetIndex < matches.length ? [matches[targetIndex], ...matches] : matches

      for (const backendNodeId of candidates) {
        try {
          await sender('DOM.describeNode', { backendNodeId })
          return backendNodeId
        } catch {
          continue
        }
      }
    } catch {
      // AX tree unavailable — can't recover
    }
    return null
  }

  private resolveTabId(webContentsId: number): string {
    return this.bridgeState.resolveTabId(webContentsId)
  }

  private getOrCreateTabState(tabId: string): CdpTabState {
    return this.bridgeState.getOrCreateTabState(tabId)
  }

  private makeCdpSender(guest: WebContents, sessionId?: string): CdpCommandSender {
    return this.debuggerLifecycle.makeCdpSender(guest, sessionId)
  }

  private getNavigationId(sender: CdpCommandSender): Promise<string> {
    return this.navigation.getNavigationId(sender)
  }
}
