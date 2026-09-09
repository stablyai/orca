// @ts-nocheck -- mechanically split declarations.
import type { BrowserScreencastResult } from '../../shared/runtime-types'
import type {
  BrowserScreencastFrameBudget,
  BrowserScreencastSession,
  BrowserScreencastViewport
} from '../browser/browser-screencast-stream-types'
import type { ScreencastSubscriberDeliveryState } from './browser-screencast-ghost-subscriber-eviction'
import {
  browserScreencastFrameBudgetsEqual,
  mergeBrowserScreencastFrameBudgets
} from '../browser/browser-screencast-frame-budget'
import type { AgentBrowserBridge } from '../browser/agent-browser-bridge'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { BrowserNetworkExecutionHost } from '../../shared/browser-client-host-protocol'
import type { BrowserHostLeaseRegistry } from './browser-host-lease-registry'
import type { RuntimeBrowserPageRegistry } from './runtime-browser-page-registry'
import type { BrowserWindow } from 'electron'
import type { BrowserBackend } from '../browser/browser-backend'
import type { BrowserSessionTabSelectionOptions } from './browser-tab-create-publication'

export type BrowserCommandTargetParams = {
  worktree?: string
  page?: string
}

export type ResolvedBrowserCommandTarget = {
  worktreeId?: string
  browserPageId?: string
}

export type ResolvedBrowserPageWebContents = {
  browserPageId: string
  webContents: Electron.WebContents
}

export type BrowserScreencastParams = {
  format: 'jpeg' | 'png'
  quality?: number
  maxWidth?: number
  maxHeight?: number
  viewportWidth?: number
  viewportHeight?: number
  deviceScaleFactor?: number
  mobile?: boolean
  everyNthFrame?: number
  minFrameIntervalMs?: number
} & BrowserCommandTargetParams

export type BrowserScreencastStartResult = {
  subscriptionId: string
  ready: Extract<BrowserScreencastResult, { type: 'ready' }>
  // The frame budget belongs to the shared page, not to one subscriber's handle.
  session: Omit<BrowserScreencastSession, 'updateFrameBudget'>
  // Why: callers gate frames until they have emitted `ready`, and the snapshot captured
  // for a joining subscriber lands inside that window. This replays it once the gate opens.
  flushPendingFrame: () => void
}

export type ActiveBrowserScreencastSubscriber = {
  sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => boolean | void
  emit?: (event: BrowserScreencastResult) => void
  done: Promise<void>
  resolveDone: () => void
  viewport: BrowserScreencastViewport
  budget: BrowserScreencastFrameBudget
  pendingFrame: Uint8Array<ArrayBufferLike> | null
  // Why: identifies the viewer across reconnects, which the RPC connectionId cannot — a new
  // socket never reuses the old id, so a reconnecting device would stack a second subscription.
  pairedDeviceId?: string
  delivery: ScreencastSubscriberDeliveryState
}

export type ActiveBrowserScreencastPage = {
  format: 'jpeg' | 'png'
  session: BrowserScreencastSession | null
  started: Promise<BrowserScreencastSession>
  stopping: boolean
  subscribers: Map<string, ActiveBrowserScreencastSubscriber>
  viewportOwnerSubscriptionId: string | null
  appliedBudget: BrowserScreencastFrameBudget
}

export async function applySharedScreencastFrameBudget(
  active: ActiveBrowserScreencastPage,
  session: BrowserScreencastSession
): Promise<void> {
  const merged = mergeBrowserScreencastFrameBudgets(
    Array.from(active.subscribers.values(), (subscriber) => subscriber.budget)
  )
  if (!merged || browserScreencastFrameBudgetsEqual(merged, active.appliedBudget)) {
    return
  }
  active.appliedBudget = merged
  await session.updateFrameBudget(merged)
}

export function normalizeScreencastViewport(
  params: BrowserScreencastParams
): BrowserScreencastViewport {
  return {
    viewportWidth: clampOptionalInteger(params.viewportWidth, 320, 3840),
    viewportHeight: clampOptionalInteger(params.viewportHeight, 240, 2160),
    deviceScaleFactor: clampOptionalNumber(params.deviceScaleFactor, 1, 4),
    mobile: params.mobile === true
  }
}

export function normalizeScreencastFrameBudget(
  params: BrowserScreencastParams
): BrowserScreencastFrameBudget {
  return {
    quality: clampInteger(params.quality, 10, 100, 70),
    maxWidth: clampInteger(params.maxWidth, 320, 3840, 1440),
    maxHeight: clampInteger(params.maxHeight, 240, 2160, 1200),
    everyNthFrame: clampInteger(params.everyNthFrame, 1, 10, 2),
    minFrameIntervalMs: clampInteger(params.minFrameIntervalMs, 0, 1000, 0)
  }
}

export function hasScreencastViewportSize(viewport: BrowserScreencastViewport): boolean {
  return viewport.viewportWidth !== undefined && viewport.viewportHeight !== undefined
}

export function clampInteger(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback
  }
  return Math.min(max, Math.max(min, Math.round(value)))
}

export function clampOptionalInteger(
  value: number | undefined,
  min: number,
  max: number
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined
  }
  return Math.min(max, Math.max(min, Math.round(value)))
}

export function clampOptionalNumber(
  value: number | undefined,
  min: number,
  max: number
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined
  }
  return Math.min(max, Math.max(min, value))
}

export type RuntimeBrowserCommandHost = {
  getAgentBrowserBridge(): AgentBrowserBridge | null
  resolveWorktreeSelector(selector: string): Promise<{
    id: string
    repoId?: string
    hostId?: ExecutionHostId
  }>
  resolveBrowserWorkspace(selector: string): Promise<{
    id: string
    repoId?: string
    hostId?: ExecutionHostId
  }>
  resolveBrowserNetworkExecutionHost(worktree?: {
    id: string
    repoId?: string
    hostId?: ExecutionHostId
  }): BrowserNetworkExecutionHost | Promise<BrowserNetworkExecutionHost>
  getBrowserHostLeaseRegistry(): BrowserHostLeaseRegistry
  getRuntimeBrowserPageRegistry(): RuntimeBrowserPageRegistry
  getAuthoritativeWindow(): BrowserWindow
  getAvailableAuthoritativeWindow(): BrowserWindow | null
  // Why: headless serve backs pages with a main-process offscreen backend; null when the environment can't support offscreen browsing.
  getOffscreenBrowserBackend(): BrowserBackend | null
  // Why: the session-tab snapshot owns focus, so a headless create must mark itself active or paired clients snap back to a terminal.
  markHeadlessBrowserSessionTabActive?(
    worktreeId: string | undefined,
    browserPageId: string,
    options?: BrowserSessionTabSelectionOptions
  ): void
  notifyHeadlessBrowserSessionTabsChanged?(worktreeId: string): void
  /** True when a runtime-owned session row for that page existed and was retired. */
  retireRuntimeOwnedBrowserSessionTab?(worktreeId: string, browserPageId: string): boolean | void
}
