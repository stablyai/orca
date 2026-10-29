import type { DnrEngine, DnrFrameCommit } from './declarative-net-request/engine'
import type { DnrFrameAllowState } from './declarative-net-request/extension-matcher'
import type { DnrResponseHeaders } from './declarative-net-request/request-context'

/** What a frame's navigation request carried, which its committed document is matched with. */
export type DnrNavigation = { url: string; isPost: boolean; responseHeaders?: DnrResponseHeaders }

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
  /** Each frame node's latest navigation request until it commits, by webContents then node. */
  private readonly navigationsByContents = new Map<number, Map<number, DnrNavigation>>()

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

  noteNavigation(webContentsId: number, frameTreeNodeId: number, navigation: DnrNavigation): void {
    let navigations = this.navigationsByContents.get(webContentsId)
    if (!navigations) {
      navigations = new Map()
      this.navigationsByContents.set(webContentsId, navigations)
    }
    navigations.set(frameTreeNodeId, navigation)
  }

  commit(
    engine: DnrEngine | null,
    webContentsId: number,
    frame: Electron.WebFrameMain,
    url: string
  ): void {
    const node = frame.frameTreeNodeId
    const navigations = this.navigationsByContents.get(webContentsId)
    const noted = navigations?.get(node)
    navigations?.delete(node)
    // A note for another URL is from a navigation that never committed.
    const navigation = noted?.url === url ? noted : undefined
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
    const parentState = parent ? this.allowByFrame.get(parent.frameTreeNodeId) : undefined
    // Why inherit: about:blank, srcdoc and blob documents run requests on their parent's behalf.
    const state = isNetworkUrl(url)
      ? engine.evaluateFrameCommit(
          this.frameCommit(webContentsId, frame, navigation ?? { url, isPost: false }, parentState)
        )
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
    { url, isPost, responseHeaders }: DnrNavigation,
    parentState: DnrFrameAllowState | undefined
  ): DnrFrameCommit {
    const committedOrigin = frame.origin
    return {
      url,
      isPost,
      responseHeaders,
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
    this.navigationsByContents.delete(webContentsId)
  }
}
