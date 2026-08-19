import {
  PI_RPC_WORKER_DISPATCH_PROTOCOL,
  PI_RPC_WORKER_DISPATCH_VERSION,
  type PiRpcWorkerDispatchEnvelope
} from '../../shared/pi-rpc-worker-launch'

export const PI_RPC_WORKER_PROTOCOL = PI_RPC_WORKER_DISPATCH_PROTOCOL
export const PI_RPC_WORKER_VERSION = PI_RPC_WORKER_DISPATCH_VERSION
export type { PiRpcWorkerDispatchEnvelope }

export type WorkerDoneInput = {
  outcome: 'succeeded' | 'failed'
  subject: string
  body: string
  filesModified?: string[]
  reportPath?: string
}

export type WorkerAskInput = {
  question: string
  options?: string[]
}

export type WorkerEscalationInput = {
  subject: string
  body: string
}

export type WorkerProgressInput = {
  phase: 'investigating' | 'implementing' | 'reviewing' | 'waiting'
  message: string
}

export type LifecycleToolInput =
  | { name: 'orca_worker_done'; input: WorkerDoneInput }
  | { name: 'orca_ask_coordinator'; input: WorkerAskInput }
  | { name: 'orca_escalate'; input: WorkerEscalationInput }
  | { name: 'orca_report_progress'; input: WorkerProgressInput }

export const LIFECYCLE_TOOL_NAMES = [
  'orca_worker_done',
  'orca_ask_coordinator',
  'orca_escalate',
  'orca_report_progress'
] as const

export type LifecycleToolName = (typeof LIFECYCLE_TOOL_NAMES)[number]

export type RpcObject = Record<string, unknown>

export type RuntimeClientLike = {
  call<TResult>(
    method: string,
    params?: unknown,
    options?: { timeoutMs?: number; orchestrationCapability?: string }
  ): Promise<{ result: TResult }>
}
