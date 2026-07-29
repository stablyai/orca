const MOBILE_TERMINAL_DIAGNOSTIC_TAG = '[terminal-diagnostic]'

type MobileTerminalDiagnosticValue = string | number | boolean | null | undefined

export type MobileTerminalDiagnosticDetails = Readonly<
  Record<string, MobileTerminalDiagnosticValue>
>

type DiagnosticTab = {
  readonly id: string
  readonly type: string
  readonly isActive: boolean
  readonly terminal?: string | null
}

type DiagnosticTabsSnapshot = {
  readonly publicationEpoch?: string
  readonly snapshotVersion: number
  readonly tabs: readonly DiagnosticTab[]
}

type DiagnosticDimensions = { readonly cols: number; readonly rows: number } | null | undefined

// Why: full runtime identifiers make shared logs unnecessarily sensitive; the
// suffix is enough to correlate lifecycle events within one reproduction.
export function shortenMobileTerminalDiagnosticId(value: string | null | undefined): string | null {
  if (!value) {
    return null
  }
  return value.slice(-8)
}

export function getMobileTerminalDiagnosticErrorName(error: unknown): string {
  if (error instanceof Error && error.name) {
    return error.name
  }
  return typeof error
}

export function logMobileTerminalDiagnostic(
  event: string,
  details: MobileTerminalDiagnosticDetails = {}
): void {
  // Why: lifecycle diagnostics are intentionally available for HMR repros,
  // but high-frequency WebView events must not add production log overhead.
  if (typeof __DEV__ !== 'undefined' && !__DEV__) {
    return
  }
  // Keep this structured and content-free so users can safely share a filtered log.
  console.log(MOBILE_TERMINAL_DIAGNOSTIC_TAG, event, details)
}

export class MobileTerminalDiagnostics {
  private readonly streamGateByHandle = new Map<string, string>()
  private readonly firstStreamEventSeqByHandle = new Map<string, number>()
  private lastFetchedTabsSignature: string | null = null
  private lastAppliedTabsSignature: string | null = null
  private lastTabsFetchStartAt = 0
  private tabsFetchSkipLogged = false

  clearTerminalCache(): void {
    this.streamGateByHandle.clear()
    this.firstStreamEventSeqByHandle.clear()
  }

  resetRoute(): void {
    this.clearTerminalCache()
    this.lastFetchedTabsSignature = null
    this.lastAppliedTabsSignature = null
    this.lastTabsFetchStartAt = 0
    this.tabsFetchSkipLogged = false
  }

  terminalUnsubscribed(handle: string): void {
    this.streamGateByHandle.delete(handle)
    this.firstStreamEventSeqByHandle.delete(handle)
  }

  viewportMeasured(handle: string, dims: DiagnosticDimensions, frameHeight: number): void {
    logMobileTerminalDiagnostic('viewport-measure', {
      handle: shortenMobileTerminalDiagnosticId(handle),
      ok: dims != null,
      cols: dims?.cols,
      rows: dims?.rows,
      frameHeight: Math.round(frameHeight)
    })
  }

  streamSkipped(handle: string, reason: string, isActive: boolean): void {
    if (this.streamGateByHandle.get(handle) === reason) {
      return
    }
    this.streamGateByHandle.set(handle, reason)
    logMobileTerminalDiagnostic('stream-skipped', {
      handle: shortenMobileTerminalDiagnosticId(handle),
      reason,
      isActive
    })
  }

  streamArmed(handle: string, seq: number, viewport: DiagnosticDimensions): void {
    this.streamGateByHandle.delete(handle)
    logMobileTerminalDiagnostic('stream-armed', {
      handle: shortenMobileTerminalDiagnosticId(handle),
      seq,
      hasViewport: viewport != null,
      viewportCols: viewport?.cols,
      viewportRows: viewport?.rows
    })
  }

  firstStreamEvent(handle: string, seq: number, type: unknown): void {
    if (this.firstStreamEventSeqByHandle.get(handle) === seq) {
      return
    }
    this.firstStreamEventSeqByHandle.set(handle, seq)
    logMobileTerminalDiagnostic('stream-first-event', {
      handle: shortenMobileTerminalDiagnosticId(handle),
      seq,
      type: typeof type === 'string' ? type : 'unknown'
    })
  }

  streamScrollback(
    handle: string,
    seq: number,
    eventSeq: number | null,
    data: Readonly<Record<string, unknown>>
  ): void {
    logMobileTerminalDiagnostic('stream-scrollback', {
      handle: shortenMobileTerminalDiagnosticId(handle),
      seq,
      eventSeq,
      cols: typeof data.cols === 'number' ? data.cols : null,
      rows: typeof data.rows === 'number' ? data.rows : null,
      serializedLength: typeof data.serialized === 'string' ? data.serialized.length : 0,
      displayMode: typeof data.displayMode === 'string' ? data.displayMode : null,
      source: typeof data.source === 'string' ? data.source : null,
      scrollbackRows: typeof data.scrollbackRows === 'number' ? data.scrollbackRows : null,
      truncated: data.truncated === true || data.truncatedByByteBudget === true
    })
  }

  streamResubscribing(handle: string, seq: number, dims: { cols: number; rows: number }): void {
    logMobileTerminalDiagnostic('stream-resubscribe-for-viewport', {
      handle: shortenMobileTerminalDiagnosticId(handle),
      seq,
      cols: dims.cols,
      rows: dims.rows
    })
  }

  streamResized(
    handle: string,
    seq: number,
    eventSeq: number | null,
    data: Readonly<Record<string, unknown>>,
    hasRef: boolean
  ): void {
    logMobileTerminalDiagnostic('stream-resized', {
      handle: shortenMobileTerminalDiagnosticId(handle),
      seq,
      eventSeq,
      cols: typeof data.cols === 'number' ? data.cols : null,
      rows: typeof data.rows === 'number' ? data.rows : null,
      serializedLength: typeof data.serialized === 'string' ? data.serialized.length : 0,
      hasRef
    })
  }

  tabsApplied(
    snapshot: DiagnosticTabsSnapshot,
    tabs: readonly DiagnosticTab[],
    activeTab: DiagnosticTab | null,
    selectionSource: string
  ): void {
    const activeHandle =
      activeTab?.type === 'terminal' && typeof activeTab.terminal === 'string'
        ? activeTab.terminal
        : null
    const appliedSnapshot = { ...snapshot, tabs }
    const signature = [
      appliedSnapshot.publicationEpoch ?? '',
      appliedSnapshot.snapshotVersion,
      activeTab?.id ?? '',
      activeHandle ?? '',
      selectionSource
    ].join(':')
    if (this.lastAppliedTabsSignature === signature) {
      return
    }
    this.lastAppliedTabsSignature = signature
    this.logTabs('tabs-applied', appliedSnapshot, activeTab, activeHandle, { selectionSource })
  }

  tabsFetchSkipped(reason: string): void {
    if (reason === 'already-in-flight' && this.tabsFetchSkipLogged) {
      return
    }
    this.tabsFetchSkipLogged = reason === 'already-in-flight'
    logMobileTerminalDiagnostic('tabs-fetch-skipped', { reason })
  }

  tabsFetchStarted(worktreeId: string): void {
    this.tabsFetchSkipLogged = false
    const now = Date.now()
    if (this.lastFetchedTabsSignature != null && now - this.lastTabsFetchStartAt < 10_000) {
      return
    }
    this.lastTabsFetchStartAt = now
    logMobileTerminalDiagnostic('tabs-fetch-start', {
      worktree: shortenMobileTerminalDiagnosticId(worktreeId)
    })
  }

  tabsFetchFailed(rpcCode: string): void {
    logMobileTerminalDiagnostic('tabs-fetch-rpc-failure', { rpcCode })
  }

  tabsFetchErrored(error: unknown): void {
    logMobileTerminalDiagnostic('tabs-fetch-error', {
      errorName: getMobileTerminalDiagnosticErrorName(error)
    })
  }

  tabsFetchSucceeded(snapshot: DiagnosticTabsSnapshot): void {
    const activeTab = snapshot.tabs.find((tab) => tab.isActive) ?? null
    const signature = [
      snapshot.publicationEpoch ?? '',
      snapshot.snapshotVersion,
      snapshot.tabs.length,
      activeTab?.id ?? '',
      activeTab?.type ?? ''
    ].join(':')
    if (this.lastFetchedTabsSignature === signature) {
      return
    }
    this.lastFetchedTabsSignature = signature
    const activeHandle =
      activeTab?.type === 'terminal' && typeof activeTab.terminal === 'string'
        ? activeTab.terminal
        : null
    this.logTabs('tabs-fetch-success', snapshot, activeTab, activeHandle)
  }

  tabSwitch(tabType: string, tabId: string, pending: boolean, handle?: string): void {
    logMobileTerminalDiagnostic('tab-switch', {
      tabType,
      tab: shortenMobileTerminalDiagnosticId(tabId),
      handle: shortenMobileTerminalDiagnosticId(handle),
      pending
    })
  }

  webViewRef(handle: string, attached: boolean): void {
    logMobileTerminalDiagnostic('webview-ref', {
      handle: shortenMobileTerminalDiagnosticId(handle),
      attached
    })
  }

  webViewReady(handle: string, reload: boolean, isActive: boolean): void {
    logMobileTerminalDiagnostic('webview-ready', {
      handle: shortenMobileTerminalDiagnosticId(handle),
      reload,
      isActive
    })
  }

  private logTabs(
    event: 'tabs-applied' | 'tabs-fetch-success',
    snapshot: DiagnosticTabsSnapshot,
    activeTab: DiagnosticTab | null,
    activeHandle: string | null,
    extra: MobileTerminalDiagnosticDetails = {}
  ): void {
    logMobileTerminalDiagnostic(event, {
      publication: shortenMobileTerminalDiagnosticId(snapshot.publicationEpoch),
      snapshotVersion: snapshot.snapshotVersion,
      tabCount: snapshot.tabs.length,
      terminalTabCount: snapshot.tabs.filter((tab) => tab.type === 'terminal').length,
      pendingTerminalCount: snapshot.tabs.filter(
        (tab) => tab.type === 'terminal' && typeof tab.terminal !== 'string'
      ).length,
      activeTab: shortenMobileTerminalDiagnosticId(activeTab?.id),
      activeType: activeTab?.type ?? null,
      activeHandle: shortenMobileTerminalDiagnosticId(activeHandle),
      ...extra
    })
  }
}
