import type { WatcherProcessSupervisor } from './parcel-watcher-process-supervisor'

export type RuntimeWatcherPoolSupervisor = Pick<WatcherProcessSupervisor, 'dispose' | 'subscribe'> &
  Partial<Pick<WatcherProcessSupervisor, 'disposeAndWait'>>

export type RuntimeWatcherPoolSlot = {
  supervisor: RuntimeWatcherPoolSupervisor
  roots: Set<string>
  isolated: boolean
  retired: boolean
  disposed: boolean
}

export function activeWatcherSlots(
  slots: ReadonlySet<RuntimeWatcherPoolSlot>,
  isolated: boolean
): RuntimeWatcherPoolSlot[] {
  return [...slots].filter((slot) => slot.isolated === isolated && !slot.retired)
}

export type RuntimeWatcherPoolAssignment = {
  slot: RuntimeWatcherPoolSlot
  leases: number
}

export type RuntimeWatcherProcessPoolOptions = {
  maxSharedSupervisors?: number
  maxQuarantineSupervisors?: number
  createSupervisor?: () => RuntimeWatcherPoolSupervisor
}
