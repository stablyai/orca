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

/** One host connection's sidebar feed, driven through the shared installer. */
export class HostSidebarFeedReader {
  private state = INITIAL_SIDEBAR_INPUTS_FEED_STATE
  private unavailable = false
  private disposed = false

  constructor(
    private readonly client: UnvalidatedRpcRequestPort,
    private readonly onRead: (read: HostSidebarFeedRead) => void
  ) {}

  /** On every stream ready and return to the foreground; supersedes a read in flight. */
  refresh(): void {
    this.apply(refreshSidebarInputs(this.state))
  }

  changed(notice: Pick<SidebarInputsChangedEvent, 'generation' | 'revision'>): void {
    this.apply(sidebarInputsChanged(this.state, notice))
  }

  dispose(): void {
    this.disposed = true
  }

  private apply(step: SidebarInputsFeedStep): void {
    const before = this.state.installed
    this.state = step.state
    if (step.state.installed !== before) {
      this.onRead({ installed: step.state.installed, unavailable: this.unavailable })
    }
    if (step.request) {
      this.send(step.request)
    }
  }

  private send(request: SidebarInputsFeedRequest): void {
    const failed = (): void => {
      this.state = sidebarInputsReadFailed(this.state, request.id)
    }
    sidebarInputsRead.request(this.client, request.params).then(
      (reply) => {
        if (this.disposed) {
          return
        }
        const read = readHostMethodReply(reply, sidebarInputsRead.interpret)
        if (read.kind === 'answered') {
          this.apply(sidebarInputsReplied(this.state, request.id, read.value))
          return
        }
        failed()
        if (read.kind === 'unavailable' && !this.unavailable) {
          this.unavailable = true
          this.onRead({ installed: this.state.installed, unavailable: true })
        }
      },
      // A dropped connection: the next ready reads again.
      failed
    )
  }
}
