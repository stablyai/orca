import { RemoteRuntimeClientError } from '../../shared/remote-runtime/remote-runtime-client-error'
import type { WslHostConnector, WslHostReachability } from './wsl-host-connector-contract'
import {
  wslHostHiddenFromPhoneMessage,
  wslHostStoppedForPhoneMessage,
  wslHostUnavailableForPhoneMessage,
  wslHostRunRefusal
} from './wsl-host-add-admission'
import { focusReachability } from './wsl-host-focus-reachability'
import type { WslHostDeploymentRecord } from '../../shared/wsl-host-deployment-store'
import type { WslHostStatus } from '../../shared/wsl-host-types'

/** What a paired phone may know of a host: `stopped` only once a stop was confirmed. */
export type WslHostPhoneReach = 'hidden' | 'ready' | 'stopped' | 'unavailable'

/** Never probes or starts the distro: the desktop's own last verdict. */
export function wslHostPhoneReach(host: {
  mayRun: boolean
  state: string | undefined
  confirmedStopped: boolean
}): WslHostPhoneReach {
  if (!host.mayRun) {
    return 'hidden'
  }
  if (host.state === 'distro-stopped' || host.confirmedStopped) {
    return 'stopped'
  }
  return host.state === 'ready' ? 'ready' : 'unavailable'
}

export function wslHostPhoneRefusal(
  reach: WslHostPhoneReach,
  distro: string
): RemoteRuntimeClientError {
  return new RemoteRuntimeClientError(
    'remote_runtime_unavailable',
    reach === 'stopped'
      ? wslHostStoppedForPhoneMessage(distro)
      : reach === 'hidden'
        ? wslHostHiddenFromPhoneMessage(distro)
        : wslHostUnavailableForPhoneMessage(distro)
  )
}

type GateStatus = Pick<WslHostStatus, 'environmentId' | 'state'>
type GateRecord = Pick<WslHostDeploymentRecord, 'distro' | 'environmentId' | 'pendingStop'>

/** What a paired phone may reach through this desktop: a host that already runs, never a start. */
export class WslHostPhoneGate {
  // A stop a phone's check confirmed, tied to the host's own status at the check (undefined: none
  // yet). It holds only while that status is still the host's current one.
  private readonly confirmedStops = new Map<string, GateStatus | undefined>()

  constructor(
    private readonly host: {
      statuses(): readonly GateStatus[]
      records(): readonly GateRecord[]
      connector: Pick<WslHostConnector, 'get' | 'reachability'>
      isEnabled: () => boolean
      hasServerFiles: () => boolean
    }
  ) {}

  /** A paired phone's call: serve a host that already runs, never start its distro for it. */
  async requireRunningWithoutStart(environmentId: string): Promise<void> {
    const record = this.host.records().find((entry) => entry.environmentId === environmentId)
    if (wslHostRunRefusal(this.host) || !record || record.pendingStop) {
      this.confirmedStops.delete(environmentId)
      throw wslHostPhoneRefusal('hidden', record?.distro ?? environmentId)
    }
    const before = this.statusOf(environmentId)
    // Why: no bridge in this process means nothing answers, so skip the running-list read.
    const reachability: WslHostReachability = await focusReachability(this.host.connector, record)
    if (reachability === 'available') {
      this.confirmedStops.delete(environmentId)
      return
    }
    const current = this.statusOf(environmentId)
    // Why: a read can be shared with one begun before a ready status, so it never outranks ready.
    if (reachability === 'stopped' && before?.state !== 'ready' && current === before) {
      this.confirmedStops.set(environmentId, before)
    }
    // The record was read above; only the status can have moved during the read.
    const reach = wslHostPhoneReach({
      mayRun: true,
      state: current?.state,
      confirmedStopped: this.isConfirmedStop(environmentId, current)
    })
    throw wslHostPhoneRefusal(reach, record.distro)
  }

  /** What a phone is told of this host; never probes or starts the distro. */
  reach(environmentId: string): WslHostPhoneReach {
    return this.reachAll().get(environmentId) ?? 'hidden'
  }

  /** Every host's reach from one records read, for a list poll. */
  reachAll(): ReadonlyMap<string, WslHostPhoneReach> {
    const mayRun = wslHostRunRefusal(this.host) === null
    const statuses = new Map(this.host.statuses().map((status) => [status.environmentId, status]))
    const reaches = new Map<string, WslHostPhoneReach>()
    for (const record of this.host.records()) {
      const status = statuses.get(record.environmentId)
      reaches.set(
        record.environmentId,
        wslHostPhoneReach({
          mayRun: mayRun && !record.pendingStop,
          state: status?.state,
          confirmedStopped: this.isConfirmedStop(record.environmentId, status)
        })
      )
    }
    for (const environmentId of this.confirmedStops.keys()) {
      if (!reaches.has(environmentId)) {
        // Removed: its confirmation goes with it.
        this.confirmedStops.delete(environmentId)
      }
    }
    return reaches
  }

  // Identity compare: the status board hands back the very objects it stores, new ones per publish.
  private isConfirmedStop(environmentId: string, status: GateStatus | undefined): boolean {
    return (
      this.confirmedStops.has(environmentId) && this.confirmedStops.get(environmentId) === status
    )
  }

  private statusOf(environmentId: string): GateStatus | undefined {
    return this.host.statuses().find((status) => status.environmentId === environmentId)
  }
}
