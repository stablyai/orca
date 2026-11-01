import type { WebContents } from 'electron'
import { BrowserError } from './browser-error'
import type { CdpTabState } from './cdp-auxiliary-commands'
import type { CdpCommandSender, RefEntry } from './snapshot-engine'
import type { CdpBridgeState } from './cdp-bridge-state'
import type { CdpDebuggerLifecycle } from './cdp-debugger-lifecycle'
import type { CdpNavigationOperations } from './cdp-navigation-operations'

export class CdpRefResolution {
  constructor(
    private readonly bridgeState: CdpBridgeState,
    private readonly debuggerLifecycle: CdpDebuggerLifecycle,
    private readonly navigation: CdpNavigationOperations
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

    // Child sessions have independent history; parent navigation IDs cannot validate their refs.
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
      // Re-rendering can detach snapshot nodes; recover from the accessibility tree.
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

  async getElementCenter(
    sender: CdpCommandSender,
    backendNodeId: number
  ): Promise<{ cx: number; cy: number }> {
    const { model } = (await sender('DOM.getBoxModel', { backendNodeId })) as {
      model: { content: number[] }
    }
    const [x1, y1, , , x3, y3] = model.content
    return { cx: (x1 + x3) / 2, cy: (y1 + y3) / 2 }
  }

  private async getIframeOffset(
    guest: WebContents,
    sessionId: string
  ): Promise<{ offsetX: number; offsetY: number }> {
    const tabId = this.resolveTabId(guest.id)
    const state = this.getOrCreateTabState(tabId)
    const parentSender = this.makeCdpSender(guest)

    for (const [targetId, sid] of state.iframeSessions) {
      if (sid === sessionId) {
        try {
          const { targetInfo } = (await parentSender('Target.getTargetInfo', {
            targetId
          })) as { targetInfo: { url?: string } }

          const targetUrl = targetInfo?.url

          const { result } = (await parentSender('Runtime.evaluate', {
            expression: `(() => {
              const frames = document.querySelectorAll('iframe, frame');
              const rects = [];
              for (const f of frames) {
                const rect = f.getBoundingClientRect();
                rects.push({ x: rect.x, y: rect.y, src: f.src || '' });
              }
              return JSON.stringify(rects);
            })()`,
            returnByValue: true
          })) as { result: { value: string } }

          const rects = JSON.parse(result.value) as { x: number; y: number; src: string }[]

          if (targetUrl) {
            for (const rect of rects) {
              if (rect.src === targetUrl) {
                return { offsetX: rect.x, offsetY: rect.y }
              }
            }
            // Redirects can change the target URL while preserving the iframe’s origin.
            try {
              const targetOrigin = new URL(targetUrl).origin
              for (const rect of rects) {
                if (rect.src && new URL(rect.src).origin === targetOrigin) {
                  return { offsetX: rect.x, offsetY: rect.y }
                }
              }
            } catch {
              // Invalid URLs still allow the single-iframe fallback.
            }
          }

          if (rects.length === 1) {
            return { offsetX: rects[0].x, offsetY: rects[0].y }
          }
        } catch {
          // If discovery fails, keep local coordinates as a best-effort fallback.
        }
        break
      }
    }

    return { offsetX: 0, offsetY: 0 }
  }

  // Input events use parent-page coordinates; iframe node geometry is frame-local.
  async getPageCoordinates(
    guest: WebContents,
    refEntry: RefEntry,
    localCx: number,
    localCy: number
  ): Promise<{ cx: number; cy: number }> {
    if (!refEntry.sessionId) {
      return { cx: localCx, cy: localCy }
    }
    const { offsetX, offsetY } = await this.getIframeOffset(guest, refEntry.sessionId)
    return { cx: localCx + offsetX, cy: localCy + offsetY }
  }

  // Prefer the snapshot ordinal among duplicate role/name matches before other live nodes.
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
      // The accessibility tree may be unavailable during recovery.
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
