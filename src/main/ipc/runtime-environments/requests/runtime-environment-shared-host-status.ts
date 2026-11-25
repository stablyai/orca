// A shared host's status, kept as a paired server's is: one owner per host, published on the same
// channel, so the window reads a shared host's contact and capabilities the way it reads any host's.
import type { SharedBotHostView } from '../../../../shared/bots/shared-bot-hosts'
import { RuntimeHostStatusOwner } from '../../../../shared/remote-runtime/host-status/runtime-host-status-owner'
import {
  RUNTIME_HOST_STATUS_CHANNEL,
  runtimeHostStatusFailure,
  type RuntimeHostStatusResponse,
  type RuntimeHostStatusSnapshot
} from '../../../../shared/remote-runtime/host-status/runtime-host-status'
import type { RuntimeRpcResponse } from '../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { getRuntimeDesktopSurface } from '../../../runtime/construction/runtime-desktop-surface'

type StatusHosts = {
  call: (selector: string, method: string, params: unknown) => Promise<RuntimeRpcResponse<unknown>>
  views: () => readonly SharedBotHostView[]
}

type Kept = { owner: RuntimeHostStatusOwner; answered: RuntimeHostStatusResponse | null }

// A share has no pairing revisions; the window keys its status by this one.
const SHARED_HOST_PAIRING_REVISION = 0

/** Main answers every call to a shared host itself (sending it, holding it, or saying the host is
 *  away), so the route is ready whenever the share holds messages or its link is live. */
function transportOf(view: SharedBotHostView | undefined): RuntimeHostStatusSnapshot['transport'] {
  if (!view) {
    return 'disconnected'
  }
  if (view.link === 'live' || view.holds) {
    return 'ready'
  }
  return view.link === 'connecting' ? 'connecting' : 'disconnected'
}

export class SharedHostStatuses {
  private readonly kept = new Map<string, Kept>()

  constructor(private readonly hosts: StatusHosts) {}

  owner(selector: string): RuntimeHostStatusOwner {
    const existing = this.kept.get(selector)
    if (existing) {
      return existing.owner
    }
    const kept: Kept = {
      answered: null,
      owner: new RuntimeHostStatusOwner({
        environmentId: selector,
        pairingRevision: SHARED_HOST_PAIRING_REVISION,
        request: async () => {
          const response = statusResponse(await this.hosts.call(selector, 'status.get', undefined))
          if (response.ok) {
            kept.answered = response
            return response
          }
          // A host away that holds messages is as it last said: its sends wait for it, not fail.
          return this.view(selector)?.holds && kept.answered ? kept.answered : response
        },
        // Link changes, not the owner's retries, say when to ask again.
        verified: () => true,
        publish: (snapshot) =>
          getRuntimeDesktopSurface().sendToRenderers?.(
            RUNTIME_HOST_STATUS_CHANNEL,
            sharedSnapshot(snapshot)
          )
      })
    }
    this.kept.set(selector, kept)
    kept.owner.connectionChanged(transportOf(this.view(selector)))
    return kept.owner
  }

  snapshots(): RuntimeHostStatusSnapshot[] {
    return [...this.kept.values()].map(({ owner }) => sharedSnapshot(owner.read()))
  }

  /** Follows each host's link; a share that is gone retires its status. */
  changed(): void {
    for (const [selector, { owner }] of this.kept) {
      const view = this.view(selector)
      if (view) {
        owner.connectionChanged(transportOf(view))
      } else {
        this.retire(selector, owner)
      }
    }
  }

  dispose(): void {
    for (const [selector, { owner }] of this.kept) {
      this.retire(selector, owner)
    }
  }

  private retire(selector: string, owner: RuntimeHostStatusOwner): void {
    owner.dispose()
    this.kept.delete(selector)
  }

  private view(selector: string): SharedBotHostView | undefined {
    return this.hosts.views().find((view) => view.environmentId === selector)
  }
}

/** The host's status, or a failure for an answer that isn't one. */
function statusResponse(response: RuntimeRpcResponse<unknown>): RuntimeHostStatusResponse {
  if (!response.ok) {
    return response
  }
  return isRuntimeStatus(response.result)
    ? { ...response, result: response.result }
    : runtimeHostStatusFailure('invalid_runtime_response', 'The host answered no status.')
}

function isRuntimeStatus(value: unknown): value is RuntimeStatus {
  return typeof value === 'object' && value !== null && 'runtimeId' in value
}

function sharedSnapshot(snapshot: RuntimeHostStatusSnapshot): RuntimeHostStatusSnapshot {
  return { ...snapshot, sharedHost: true }
}
