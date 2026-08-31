import { RuntimeClientError } from '../../runtime-client'

export type MissionWorkerStartResult = {
  taskId: string
  dispatchId: string
  state: string
  failedStage?: string
  lastError?: string
  effects?: { kind: string; action?: string; state?: string }[]
  residualResources?: unknown[]
}

export class MissionWorkerStartFailure extends RuntimeClientError {
  settled = false

  constructor(
    message: string,
    readonly noResidualEffects: boolean
  ) {
    super('mission_worker_start_failed', message)
  }
}

export function isNoEffectStartFailure(receipt: MissionWorkerStartResult): boolean {
  return (
    receipt.state === 'failed' &&
    receipt.failedStage === 'terminal_create' &&
    Array.isArray(receipt.residualResources) &&
    receipt.residualResources.length === 0 &&
    Array.isArray(receipt.effects) &&
    receipt.effects.every(
      (effect) =>
        (effect.kind === 'worktree' && effect.action === 'reused') ||
        (effect.kind === 'setup' &&
          effect.action === 'not_applicable' &&
          effect.state === 'not_applicable')
    )
  )
}

export function markNoEffectFailuresSettled(failures: ReadonlyMap<string, unknown>): void {
  if (
    [...failures.values()].every(
      (error) => error instanceof MissionWorkerStartFailure && error.noResidualEffects
    )
  ) {
    for (const error of failures.values()) {
      if (error instanceof MissionWorkerStartFailure) {
        error.settled = true
      }
    }
  }
}
