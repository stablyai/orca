import {
  ORCHESTRATION_ASK_CLIENT_GRACE_MS,
  ORCHESTRATION_ASK_DEFAULT_TIMEOUT_MS
} from '../../shared/orchestration-ask-timeout'
import type {
  PiRpcWorkerDispatchEnvelope,
  RuntimeClientLike,
  WorkerAskInput,
  WorkerDoneInput,
  WorkerEscalationInput,
  WorkerProgressInput
} from './types'

export type RuntimeCall = {
  method: 'orchestration.ask' | 'orchestration.send'
  params: Record<string, unknown>
  options: { timeoutMs?: number; orchestrationCapability: string }
}

function redact(envelope: PiRpcWorkerDispatchEnvelope, value: string): string {
  let result = value
  for (const secret of [
    envelope.taskId,
    envelope.dispatchId,
    envelope.workerHandle,
    envelope.capability
  ]) {
    if (secret.length >= 3) {
      result = result.split(secret).join('[redacted]')
    }
  }
  return result
}

function payload(
  envelope: PiRpcWorkerDispatchEnvelope,
  extra: Record<string, unknown> = {}
): string {
  return JSON.stringify({
    taskId: envelope.taskId,
    dispatchId: envelope.dispatchId,
    ...extra
  })
}

function sendCall(
  envelope: PiRpcWorkerDispatchEnvelope,
  params: Record<string, unknown>
): RuntimeCall {
  return {
    method: 'orchestration.send',
    params: {
      from: envelope.workerHandle,
      senderPaneKey: process.env.ORCA_PANE_KEY || undefined,
      ...params
    },
    options: { orchestrationCapability: envelope.capability }
  }
}

export function buildHeartbeatCall(envelope: PiRpcWorkerDispatchEnvelope): RuntimeCall {
  return sendCall(envelope, {
    subject: 'alive',
    type: 'heartbeat',
    payload: payload(envelope, { phase: 'implementing' })
  })
}

export function buildProgressCall(
  envelope: PiRpcWorkerDispatchEnvelope,
  input: WorkerProgressInput
): RuntimeCall {
  const phase = redact(envelope, input.phase)
  return sendCall(envelope, {
    subject: phase,
    body: redact(envelope, input.message),
    type: 'status',
    payload: payload(envelope, { phase })
  })
}

export function buildEscalationCall(
  envelope: PiRpcWorkerDispatchEnvelope,
  input: WorkerEscalationInput
): RuntimeCall {
  return sendCall(envelope, {
    subject: redact(envelope, input.subject),
    body: redact(envelope, input.body),
    type: 'escalation',
    payload: payload(envelope)
  })
}

export function buildWorkerDoneCall(
  envelope: PiRpcWorkerDispatchEnvelope,
  input: WorkerDoneInput
): RuntimeCall {
  return sendCall(envelope, {
    subject: redact(envelope, input.subject),
    body: redact(envelope, input.body),
    type: 'worker_done',
    payload: payload(envelope, {
      outcome: input.outcome,
      ...(input.filesModified
        ? { filesModified: input.filesModified.map((file) => redact(envelope, file)) }
        : {}),
      ...(input.reportPath ? { reportPath: redact(envelope, input.reportPath) } : {})
    }),
    waitForLifecycleSettlement: true
  })
}

export function buildAskCall(
  envelope: PiRpcWorkerDispatchEnvelope,
  input: WorkerAskInput,
  timeoutMs: number,
  resume?: string
): RuntimeCall {
  return {
    method: 'orchestration.ask',
    params: {
      from: envelope.workerHandle,
      timeoutMs,
      ...(resume
        ? { resume }
        : {
            question: redact(envelope, input.question),
            ...(input.options && input.options.length > 0
              ? { options: input.options.map((option) => redact(envelope, option)).join(',') }
              : {})
          })
    },
    options: {
      timeoutMs: timeoutMs + ORCHESTRATION_ASK_CLIENT_GRACE_MS,
      orchestrationCapability: envelope.capability
    }
  }
}

type AskResult = {
  answer: string | null
  messageId: string | null
  timedOut: boolean
  cancelled?: boolean
  connectionLost?: boolean
}

type WorkerDoneResult = {
  lifecycle?: {
    action?: string
    outcome?: string
    duplicate?: boolean
  }
}

function validateWorkerDoneSettlement(
  result: WorkerDoneResult,
  outcome: WorkerDoneInput['outcome']
): void {
  const lifecycle = result.lifecycle
  if (!lifecycle || lifecycle.duplicate === true || lifecycle.action === 'rejected') {
    throw new Error('Orca runtime did not accept the exact worker completion')
  }
  const expectedAction = outcome === 'succeeded' ? 'completed' : 'failed'
  if (lifecycle.action === expectedAction) {
    return
  }
  if (lifecycle.action === 'settled' && lifecycle.outcome === outcome) {
    return
  }
  throw new Error('Orca runtime lifecycle settlement did not match the worker outcome')
}

export class PiWorkerRuntime {
  constructor(
    private readonly client: RuntimeClientLike,
    private readonly envelope: PiRpcWorkerDispatchEnvelope
  ) {}

  async heartbeat(): Promise<void> {
    await this.invoke(buildHeartbeatCall(this.envelope))
  }

  async progress(input: WorkerProgressInput): Promise<void> {
    await this.invoke(buildProgressCall(this.envelope, input))
  }

  async escalate(input: WorkerEscalationInput): Promise<void> {
    await this.invoke(buildEscalationCall(this.envelope, input))
  }

  async ask(input: WorkerAskInput): Promise<string> {
    const deadline = Date.now() + ORCHESTRATION_ASK_DEFAULT_TIMEOUT_MS
    let resume: string | undefined
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        break
      }
      const result = await this.invoke<AskResult>(
        buildAskCall(this.envelope, input, remaining, resume)
      )
      if (result.answer !== null) {
        if (result.answer.length > 16_384 || result.answer.includes('\0')) {
          throw new Error('Coordinator answer exceeded the safe response bound')
        }
        return result.answer
      }
      if (result.connectionLost && result.messageId) {
        resume = result.messageId
        continue
      }
      if (result.timedOut || result.cancelled) {
        break
      }
      throw new Error('Coordinator question returned without an answer')
    }
    throw new Error('Coordinator question did not receive a bounded answer')
  }

  async workerDone(input: WorkerDoneInput): Promise<void> {
    const result = await this.invoke<WorkerDoneResult>(buildWorkerDoneCall(this.envelope, input))
    validateWorkerDoneSettlement(result, input.outcome)
  }

  private async invoke<TResult = unknown>(call: RuntimeCall): Promise<TResult> {
    const response = await this.client.call<TResult>(call.method, call.params, call.options)
    return response.result
  }
}
