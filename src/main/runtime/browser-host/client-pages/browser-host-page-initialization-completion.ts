import type { BrowserHostLeaseState } from '../leases/browser-host-lease-records'
import type {
  InitializationRecord,
  InitializationOutcome
} from './browser-host-page-initialization-records'

type Completion = {
  state: BrowserHostLeaseState
  members: Set<InitializationRecord>
  sealed: boolean
  blocked: boolean
  complete: () => void
}

export class BrowserHostInitializationCompletion {
  private readonly contexts = new Map<symbol, Completion>()
  private readonly contextsByDevice = new Map<string, Set<Completion>>()
  private readonly contextsByRecord = new WeakMap<InitializationRecord, Set<Completion>>()

  begin(
    state: BrowserHostLeaseState,
    records: Iterable<InitializationRecord>,
    complete: () => void
  ): void {
    const previous = this.contexts.get(state.token)
    if (previous) {
      this.remove(previous)
    }
    const members = new Set<InitializationRecord>()
    for (const record of records) {
      if (
        !isCleanStoppedInitialization(record) &&
        (record.scope === state ||
          record.operation?.admission.state === state ||
          record.successor?.state === state)
      ) {
        members.add(record)
      }
    }
    const context = { state, members, sealed: false, blocked: false, complete }
    this.contexts.set(state.token, context)
    const device = state.lease.pairedDeviceId
    const contexts = this.contextsByDevice.get(device) ?? new Set<Completion>()
    contexts.add(context)
    this.contextsByDevice.set(device, contexts)
    for (const record of members) {
      this.link(context, record)
    }
  }

  join(state: BrowserHostLeaseState, record: InitializationRecord): void {
    const context = this.contexts.get(state.token)
    if (context) {
      this.link(context, record)
    }
  }

  pendingRecords(state: BrowserHostLeaseState): Iterable<InitializationRecord> {
    return this.contexts.get(state.token)?.members ?? []
  }

  seal(state: BrowserHostLeaseState, blocked: boolean): void {
    const context = this.contexts.get(state.token)
    if (!context) {
      return
    }
    context.sealed = true
    context.blocked = blocked
    this.publish(state.lease.pairedDeviceId)
  }

  settle(record: InitializationRecord, outcome: InitializationOutcome): void {
    if (outcome !== 'published' && outcome !== 'retained-clean' && outcome !== 'disposed') {
      return
    }
    this.publishDevices(this.unlink(record))
  }

  unlink(record: InitializationRecord): Set<string> {
    const devices = new Set<string>()
    const contexts = this.contextsByRecord.get(record)
    this.contextsByRecord.delete(record)
    for (const context of contexts ?? []) {
      context.members.delete(record)
      devices.add(context.state.lease.pairedDeviceId)
    }
    return devices
  }

  retire(state: BrowserHostLeaseState): void {
    const context = this.contexts.get(state.token)
    if (context) {
      this.remove(context)
    }
  }

  publishDevices(devices: Iterable<string>): void {
    for (const device of devices) {
      this.publish(device)
    }
  }

  private link(context: Completion, record: InitializationRecord): void {
    if (isCleanStoppedInitialization(record)) {
      return
    }
    context.members.add(record)
    const contexts = this.contextsByRecord.get(record) ?? new Set<Completion>()
    contexts.add(context)
    this.contextsByRecord.set(record, contexts)
  }

  private remove(context: Completion): void {
    this.contexts.delete(context.state.token)
    const device = context.state.lease.pairedDeviceId
    const contexts = this.contextsByDevice.get(device)
    contexts?.delete(context)
    if (!contexts?.size) {
      this.contextsByDevice.delete(device)
    }
    for (const record of context.members) {
      this.contextsByRecord.get(record)?.delete(context)
    }
    context.members.clear()
  }

  private publish(device: string): void {
    let completed: Completion | undefined
    for (const context of this.contextsByDevice.get(device) ?? []) {
      if (!context.sealed || context.blocked || context.members.size) {
        return
      }
      completed = context
    }
    completed?.complete()
  }
}

function isCleanStoppedInitialization(record: InitializationRecord): boolean {
  return Boolean(record.stopped && !record.target && !record.operation && !record.successor)
}
