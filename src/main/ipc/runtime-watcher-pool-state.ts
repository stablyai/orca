import type { WatcherProcessSupervisor } from './parcel-watcher-process-supervisor'

export type RuntimeWatcherPoolSupervisor = Pick<WatcherProcessSupervisor, 'dispose' | 'subscribe'>

export type RuntimeWatcherPoolSlot = {
  supervisor: RuntimeWatcherPoolSupervisor
  roots: Set<string>
  isolated: boolean
  retired: boolean
  disposed: boolean
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
