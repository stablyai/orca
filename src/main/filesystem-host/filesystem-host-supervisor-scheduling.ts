import type {
  FilesystemHostOperation,
  FilesystemHostResult
} from '../../shared/filesystem-host-protocol'
import type { FilesystemHostBreaker } from './filesystem-host-breaker'
import type { FilesystemHostAdmissionClass } from './filesystem-host-capacity'
import type { FilesystemExecutionHost } from './filesystem-host-failure-domain'
import type { FilesystemHostProcess } from './filesystem-host-process'
import type { FilesystemStorageClass } from './filesystem-host-telemetry'

export type FilesystemHostDispatch = {
  operationId: string
  operation: FilesystemHostOperation
  executionHost: FilesystemExecutionHost
  storageClass: FilesystemStorageClass
  admission: FilesystemHostAdmissionClass
  deadlineMs: number
}

export type FilesystemHostProcessHandle = Pick<FilesystemHostProcess, 'invoke' | 'retire'>

export type FilesystemHostQueuedDispatch = {
  input: FilesystemHostDispatch
  resolve: (result: FilesystemHostResult) => void
  reject: (error: unknown) => void
}

export type FilesystemHostLane = {
  key: string
  retireWhenIdle: boolean
  retiring: boolean
  breaker: FilesystemHostBreaker
  process: FilesystemHostProcessHandle | null
  foreground: FilesystemHostQueuedDispatch[]
  background: FilesystemHostQueuedDispatch[]
  running: boolean
  pending: number
}
