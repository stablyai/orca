import type { DnrEngine, DnrFrameCommit } from './declarative-net-request/engine'
import type { DnrFrameAllowState } from './declarative-net-request/extension-matcher'

function originOf(url: string): string | null {
  try {
    const origin = new URL(url).origin
    return origin === 'null' ? null : origin
  } catch {
    return null
  }
}

function isNetworkUrl(url: string): boolean {
  return /^(?:https?|wss?):/i.test(url)
}

/**
 * Per-document state the request path reads, keyed by Electron frame-tree node: each frame's
 * allowAllRequests decisions (RulesetManager::OnDidFinishNavigation) and each tab's top origin.
 * A commit replaces the frame's state, so a node always holds its current document's.
 */
export class DnrFrameTracker {
  private readonly allowByFrame = new Map<number, DnrFrameAllowState>()
  private readonly framesByContents = new Map<number, Set<number>>()
  private readonly topOriginByContents = new Map<number, string>()
  private readonly tabIdByContents = new Map<number, number>()

  constructor(private readonly resolveTabId: (webContentsId: number) => number) {}

  hasAllowStates(): boolean {
    return this.allowByFrame.size > 0
  }

  allowFor(frameTreeNodeId: number): DnrFrameAllowState | undefined {
    return this.allowByFrame.get(frameTreeNodeId)
  }

  topOrigin(webContentsId: number): string | null {
    return this.topOriginByContents.get(webContentsId) ?? null
  }

  /** Chrome's tab id for a request's webContents (-1 outside tabs), resolved once per document. */
  tabIdFor(webContentsId: number | undefined): number {
    if (webContentsId === undefined) {
      return -1
    }
    const cached = this.tabIdByContents.get(webContentsId)
    if (cached !== undefined) {
      return cached
    }
    const tabId = this.resolveTabId(webContentsId)
    // Why only tabs: a restored guest loads before Orca's window lists it as a tab.
    if (tabId !== -1) {
      this.tabIdByContents.set(webContentsId, tabId)
    }
    return tabId
  }

  commit(
    engine: DnrEngine | null,
    webContentsId: number,
    frame: Electron.WebFrameMain,
    url: string
  ): void {
    const parent = frame.parent
    if (!parent) {
      this.forgetContents(webContentsId)
      const origin = originOf(url)
      if (origin) {
        this.topOriginByContents.set(webContentsId, origin)
      }
    }
    if (!engine) {
      return
    }
    const node = frame.frameTreeNodeId
    const parentState = parent ? this.allowByFrame.get(parent.frameTreeNodeId) : undefined
    // Why inherit: about:blank, srcdoc and blob documents run requests on their parent's behalf.
    const state = isNetworkUrl(url)
      ? engine.evaluateFrameCommit(this.frameCommit(webContentsId, frame, url, parentState))
      : parentState
    let frames = this.framesByContents.get(webContentsId)
    if (state && state.size > 0) {
      this.allowByFrame.set(node, state)
      if (!frames) {
        frames = new Set()
        this.framesByContents.set(webContentsId, frames)
      }
      frames.add(node)
    } else {
      this.allowByFrame.delete(node)
      frames?.delete(node)
    }
  }

  private frameCommit(
    webContentsId: number,
    frame: Electron.WebFrameMain,
    url: string,
    parentState: DnrFrameAllowState | undefined
  ): DnrFrameCommit {
    const committedOrigin = frame.origin
    return {
      url,
      // Electron does not say which method committed the document.
      isPost: false,
      parentOrigin: frame.parent?.origin ?? null,
      ...(committedOrigin !== originOf(url) ? { committedOrigin } : {}),
      topFrameOrigin: this.topOrigin(webContentsId),
      tabId: this.tabIdFor(webContentsId),
      parentState
    }
  }

  /** Main frame committed or contents destroyed: drop everything held for its documents. */
  forgetContents(webContentsId: number): void {
    for (const node of this.framesByContents.get(webContentsId) ?? []) {
      this.allowByFrame.delete(node)
    }
    this.framesByContents.delete(webContentsId)
    this.topOriginByContents.delete(webContentsId)
    this.tabIdByContents.delete(webContentsId)
  }
}
