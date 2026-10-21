import {
  INITIAL_SIDEBAR_INPUTS_FEED_STATE,
  refreshSidebarInputs,
  sidebarInputsChanged,
  sidebarInputsReadFailed,
  sidebarInputsReplied,
  type InstalledSidebarInputs,
  type SidebarInputsFeedRequest,
  type SidebarInputsFeedStep
} from '../../../src/shared/sidebar-list/sidebar-inputs-feed-installer'
import type { SidebarInputsChangedEvent } from '../../../src/shared/sidebar-list/sidebar-inputs-feed-contract'
import type { UnvalidatedRpcRequestPort } from '../transport/unvalidated-rpc-request-port'
import { readHostMethodReply, sidebarInputsRead } from './host-sidebar-feed-operations'

/** What the worktree refresh drives the feed with. */
export type HostSidebarFeedTriggers = {
  refresh: () => void
  changed: (notice: Pick<SidebarInputsChangedEvent, 'generation' | 'revision'>) => void
  /** Each new install; returns the unsubscribe. */
  onInstalled: (listener: () => void) => () => void
}

export type HostSidebarFeedRead = {
  installed: InstalledSidebarInputs | null
  /** The host has no feed (method_not_found, or forbidden by an older mobile allowlist). */
  unavailable: boolean
}

// A read that fails with the connection up gets no ready to repeat it; back off so a failing host is not hammered.
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000]

/** One host connection's sidebar feed, driven through the shared installer. */
export class HostSidebarFeedReader {
  private state = INITIAL_SIDEBAR_INPUTS_FEED_STATE
  private unavailable = false
  private disposed = false
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retries = 0

  constructor(
    private readonly client: UnvalidatedRpcRequestPort,
    private readonly onRead: (read: HostSidebarFeedRead) => void
  ) {}

  /** On every stream ready and return to the foreground; supersedes a read in flight. */
  refresh(): void {
    this.retries = 0
    this.apply(refreshSidebarInputs(this.state))
  }

  changed(notice: Pick<SidebarInputsChangedEvent, 'generation' | 'revision'>): void {
    this.apply(sidebarInputsChanged(this.state, notice))
  }

  dispose(): void {
    this.disposed = true
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }

  private apply(step: SidebarInputsFeedStep): void {
    const before = this.state.installed
    this.state = step.state
    if (step.state.installed !== before) {
      // Only an install ends a failure streak: a page that answers mid-batch does not.
      this.retries = 0
      this.onRead({ installed: step.state.installed, unavailable: this.unavailable })
    }
    if (step.request) {
      this.send(step.request)
    }
  }

  /** Reads again from what is installed, which the host answers past every notice so far. */
  private retry(): void {
    const delay = RETRY_DELAYS_MS[this.retries]
    if (this.disposed || this.retryTimer || delay === undefined) {
      return
    }
    this.retries += 1
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (this.state.inFlight === null) {
        this.apply(refreshSidebarInputs(this.state))
      }
    }, delay)
  }

  private send(request: SidebarInputsFeedRequest): void {
    const failed = (): void => {
      if (this.disposed || request.id !== this.state.inFlight) {
        return
      }
      this.state = sidebarInputsReadFailed(this.state, request.id)
      if (!this.unavailable) {
        this.retry()
      }
    }
    sidebarInputsRead.request(this.client, request.params).then((reply) => {
      if (this.disposed) {
        return
      }
      const read = readHostMethodReply(reply, sidebarInputsRead.interpret)
      if (read.kind === 'answered') {
        this.apply(sidebarInputsReplied(this.state, request.id, read.value))
        return
      }
      if (read.kind === 'unavailable' && !this.unavailable) {
        this.unavailable = true
        this.onRead({ installed: this.state.installed, unavailable: true })
      }
      failed()
    }, failed)
  }
}
