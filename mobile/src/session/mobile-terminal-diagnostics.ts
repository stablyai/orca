const MOBILE_TERMINAL_DIAGNOSTIC_TAG = '[terminal-diagnostic]'

type MobileTerminalDiagnosticEvent =
  | 'activation-cutover-retry'
  | 'activation-error'
  | 'activation-request'
  | 'activation-result'
  | 'stream-armed'
  | 'stream-first-event'
  | 'stream-resized'
  | 'stream-resubscribe-exhausted'
  | 'stream-resubscribe-for-viewport'
  | 'stream-resubscribe-held-absent-dims'
  | 'stream-scrollback'
  | 'stream-skipped'
  | 'tab-switch'
  | 'tabs-applied'
  | 'tabs-fetch-error'
  | 'tabs-fetch-rpc-failure'
  | 'tabs-fetch-skipped'
  | 'tabs-fetch-start'
  | 'tabs-fetch-success'
  | 'viewport-measure'
  | 'webview-ready'
  | 'webview-ref'

type MobileTerminalDiagnosticValue = string | number | boolean | null | undefined

export type MobileTerminalDiagnosticDetails = Readonly<
  Record<string, MobileTerminalDiagnosticValue>
>

// Why: full runtime identifiers make shared logs unnecessarily sensitive; the
// suffix is enough to correlate lifecycle events within one reproduction.
export function shortenMobileTerminalDiagnosticId(value: string | null | undefined): string | null {
  return value ? value.slice(-8) : null
}

export function getMobileTerminalDiagnosticErrorName(error: unknown): string {
  return error instanceof Error && error.name ? error.name : typeof error
}

type MobileTerminalDiagnosticRecord = {
  event: MobileTerminalDiagnosticEvent
  details: MobileTerminalDiagnosticDetails
}

type MobileTerminalDiagnosticGlobal = typeof globalThis & {
  __orcaCaptureMobileTerminalDiagnostics?: boolean
  __orcaMobileTerminalDiagnostics?: MobileTerminalDiagnosticRecord[]
}

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

export function logMobileTerminalDiagnostic(
  event: MobileTerminalDiagnosticEvent,
  details: MobileTerminalDiagnosticDetails = {}
): void {
  const target = globalThis as MobileTerminalDiagnosticGlobal
  // Why: lifecycle diagnostics are intentionally available for HMR repros,
  // but high-frequency WebView events must not add production log overhead.
  if (
    typeof __DEV__ !== 'undefined' &&
    !__DEV__ &&
    target.__orcaCaptureMobileTerminalDiagnostics !== true
  ) {
    return
  }
  target.__orcaMobileTerminalDiagnostics = [
    ...(target.__orcaMobileTerminalDiagnostics ?? []).slice(-63),
    { event, details }
  ]
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

  viewportMeasured(_handle: string, dims: DiagnosticDimensions, frameHeight: number): void {
    logMobileTerminalDiagnostic('viewport-measure', {
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
      isActive
    })
  }

  streamArmed(handle: string, seq: number, viewport: DiagnosticDimensions): void {
    this.streamGateByHandle.delete(handle)
    logMobileTerminalDiagnostic('stream-armed', {
      seq,
      hasViewport: viewport != null,
      viewportCols: viewport?.cols,
      viewportRows: viewport?.rows
    })
  }

  firstStreamEvent(handle: string, seq: number, _type: unknown): void {
    if (this.firstStreamEventSeqByHandle.get(handle) === seq) {
      return
    }
    this.firstStreamEventSeqByHandle.set(handle, seq)
    logMobileTerminalDiagnostic('stream-first-event', {
      seq
    })
  }

  streamScrollback(
    _handle: string,
    seq: number,
    eventSeq: number | null,
    data: Readonly<Record<string, unknown>>
  ): void {
    logMobileTerminalDiagnostic('stream-scrollback', {
      seq,
      eventSeq,
      cols: typeof data.cols === 'number' ? data.cols : null,
      rows: typeof data.rows === 'number' ? data.rows : null,
      serializedLength: terminalDataLength(data.serialized),
      oscLinkCount: Array.isArray(data.oscLinks) ? data.oscLinks.length : null,
      scrollbackRows: typeof data.scrollbackRows === 'number' ? data.scrollbackRows : null,
      truncated: data.truncated === true || data.truncatedByByteBudget === true
    })
  }

  streamResubscribing(
    _handle: string,
    seq: number,
    dims: { cols: number; rows: number },
    attempt?: number,
    delayMs?: number
  ): void {
    logMobileTerminalDiagnostic('stream-resubscribe-for-viewport', {
      seq,
      cols: dims.cols,
      rows: dims.rows,
      attempt,
      delayMs
    })
  }

  streamResubscribeHeld(_handle: string, seq: number): void {
    logMobileTerminalDiagnostic('stream-resubscribe-held-absent-dims', {
      seq
    })
  }

  streamResubscribeExhausted(_handle: string, seq: number, attempts: number): void {
    logMobileTerminalDiagnostic('stream-resubscribe-exhausted', {
      seq,
      attempts
    })
  }

  streamResized(
    _handle: string,
    seq: number,
    eventSeq: number | null,
    data: Readonly<Record<string, unknown>>,
    hasRef: boolean
  ): void {
    logMobileTerminalDiagnostic('stream-resized', {
      seq,
      eventSeq,
      cols: typeof data.cols === 'number' ? data.cols : null,
      rows: typeof data.rows === 'number' ? data.rows : null,
      serializedLength: terminalDataLength(data.serialized),
      oscLinkCount: Array.isArray(data.oscLinks) ? data.oscLinks.length : null,
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
    this.logTabs('tabs-applied', appliedSnapshot, activeTab, activeHandle)
  }

  tabsFetchSkipped(reason: string): void {
    if (reason === 'already-in-flight' && this.tabsFetchSkipLogged) {
      return
    }
    this.tabsFetchSkipLogged = reason === 'already-in-flight'
    logMobileTerminalDiagnostic('tabs-fetch-skipped', {
      alreadyInFlight: reason === 'already-in-flight'
    })
  }

  tabsFetchStarted(_worktreeId: string): void {
    this.tabsFetchSkipLogged = false
    const now = Date.now()
    if (this.lastFetchedTabsSignature != null && now - this.lastTabsFetchStartAt < 10_000) {
      return
    }
    this.lastTabsFetchStartAt = now
    logMobileTerminalDiagnostic('tabs-fetch-start')
  }

  tabsFetchFailed(_rpcCode: string): void {
    logMobileTerminalDiagnostic('tabs-fetch-rpc-failure')
  }

  tabsFetchErrored(error: unknown): void {
    logMobileTerminalDiagnostic('tabs-fetch-error', {
      isErrorObject: error instanceof Error
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

  tabSwitch(tabType: string, _tabId: string, pending: boolean, _handle?: string): void {
    logMobileTerminalDiagnostic('tab-switch', {
      terminal: tabType === 'terminal',
      pending
    })
  }

  webViewRef(_handle: string, attached: boolean): void {
    logMobileTerminalDiagnostic('webview-ref', {
      attached
    })
  }

  webViewReady(_handle: string, reload: boolean, isActive: boolean): void {
    logMobileTerminalDiagnostic('webview-ready', {
      reload,
      isActive
    })
  }

  private logTabs(
    event: 'tabs-applied' | 'tabs-fetch-success',
    snapshot: DiagnosticTabsSnapshot,
    activeTab: DiagnosticTab | null,
    activeHandle: string | null
  ): void {
    logMobileTerminalDiagnostic(event, {
      snapshotVersion: snapshot.snapshotVersion,
      tabCount: snapshot.tabs.length,
      terminalTabCount: snapshot.tabs.filter((tab) => tab.type === 'terminal').length,
      pendingTerminalCount: snapshot.tabs.filter(
        (tab) => tab.type === 'terminal' && typeof tab.terminal !== 'string'
      ).length,
      activeTerminal: activeTab?.type === 'terminal',
      activeHandleReady: activeHandle !== null
    })
  }
}

function terminalDataLength(value: unknown): number {
  return typeof value === 'string'
    ? value.length
    : value instanceof Uint8Array
      ? value.byteLength
      : 0
}
