import { TEXT_GENERATION_FAILURE_COPY } from '../../shared/text-generation-failure-copy'
import { SOURCE_CONTROL_GENERATION_TIMEOUT_MS } from './source-control-generation-limits'
import type { TextGenerationOperation } from './source-control-text-generation-types'

type GenerationCancelToken = { cancel?: () => void; request?: LocalGenerationRequest }
const cancelTokensByLane = new Map<string, GenerationCancelToken>()

export type SourceControlGenerationRequestIdentity = { owner: string; generationId: string }
type GenerationRequestTarget = { cwd: string; wslDistro?: string }

function requestLaneKey(
  operation: TextGenerationOperation,
  identity: SourceControlGenerationRequestIdentity
): string {
  if (
    typeof identity.generationId !== 'string' ||
    !identity.generationId.trim() ||
    identity.generationId.length > 128
  ) {
    throw new Error('Invalid generation request ID.')
  }
  return JSON.stringify([operation, identity.owner, identity.generationId])
}

function requestTargetKey(target: GenerationRequestTarget): string {
  return JSON.stringify([target.cwd, target.wslDistro ?? null])
}

export class LocalGenerationRequest {
  budget?: TextGenerationRequest
  validateTarget?: () => Promise<boolean>
  private readonly startedAt = Date.now()
  // Every path this request ran under; a folder rename adds the new path so Stop for either cancels.
  private readonly boundTargets = new Map<string, GenerationRequestTarget>()
  private readonly canceledTargetKeys: Set<string>
  private canceledByUser = false
  private cancelToken: (() => void) | undefined

  constructor(
    private readonly laneKey: string,
    private readonly operation: TextGenerationOperation,
    earlyCanceledTargetKeys?: Set<string>
  ) {
    this.canceledTargetKeys = earlyCanceledTargetKeys ?? new Set()
  }

  get canceled(): boolean {
    return this.canceledByUser
  }

  bindTarget(target: GenerationRequestTarget): void {
    const targetKey = requestTargetKey(target)
    this.boundTargets.set(targetKey, { cwd: target.cwd, wslDistro: target.wslDistro })
    if (this.canceledTargetKeys.has(targetKey)) {
      this.cancel()
    }
  }

  aliasTargetPath(oldCwd: string, newCwd: string): void {
    for (const target of Array.from(this.boundTargets.values())) {
      if (target.cwd === oldCwd) {
        this.bindTarget({ ...target, cwd: newCwd })
      }
    }
  }

  startBudget(target: GenerationRequestTarget): TextGenerationRequest {
    if (!this.budget) {
      this.budget = beginTextGenerationRequest(
        this.operation,
        target.cwd,
        Math.max(1, SOURCE_CONTROL_GENERATION_TIMEOUT_MS - (Date.now() - this.startedAt)),
        () => !this.canceled && cancelTokensByLane.get(this.laneKey)?.request === this,
        async () => !this.validateTarget || (await this.validateTarget()),
        this.laneKey
      )
      this.attachCancelToken(this.budget.cancel)
    }
    return this.budget
  }

  discardBudget(): void {
    const budget = this.budget
    if (budget) {
      this.budget = undefined
      this.detachCancelToken(budget.cancel)
      budget.finish()
    }
  }

  cancelForPath(operation: TextGenerationOperation, cwd: string): void {
    if (
      operation === this.operation &&
      Array.from(this.boundTargets.values()).some((target) => target.cwd === cwd)
    ) {
      this.cancel()
    }
  }

  cancelForTarget(target: GenerationRequestTarget): void {
    const targetKey = requestTargetKey(target)
    if (this.boundTargets.size === 0) {
      // Stop may finish authorization while Generate is still resolving its target.
      this.canceledTargetKeys.add(targetKey)
    } else if (this.boundTargets.has(targetKey)) {
      this.cancel()
    }
  }

  attachCancelToken(cancel: () => void): void {
    this.cancelToken = cancel
    if (this.canceled) {
      cancel()
    }
  }

  detachCancelToken(cancel: () => void): void {
    if (this.cancelToken === cancel) {
      this.cancelToken = undefined
    }
  }

  release(): void {
    this.budget?.finish()
    if (cancelTokensByLane.get(this.laneKey)?.request === this) {
      cancelTokensByLane.delete(this.laneKey)
    }
  }

  private cancel(): void {
    if (!this.canceledByUser) {
      this.canceledByUser = true
      this.cancelToken?.()
    }
  }
}

export function beginLocalGenerationRequest(
  operation: TextGenerationOperation,
  identity?: SourceControlGenerationRequestIdentity
): LocalGenerationRequest | undefined {
  if (!identity) {
    return undefined
  }
  const laneKey = requestLaneKey(operation, identity)
  if (cancelTokensByLane.has(laneKey)) {
    throw new Error('This generation request is already running.')
  }
  const request = new LocalGenerationRequest(laneKey, operation, takeEarlyStop(laneKey))
  cancelTokensByLane.set(laneKey, { request })
  return request
}

const MAX_EARLY_STOPS = 64
// One-shot RPCs use separate sockets, so an authorized Stop can land before its Generate registers.
const earlyStopsByLane = new Map<string, { targetKeys: Set<string>; expiresAt: number }>()

function pruneEarlyStops(now: number): void {
  for (const [laneKey, stop] of earlyStopsByLane) {
    if (stop.expiresAt <= now) {
      earlyStopsByLane.delete(laneKey)
    }
  }
}

function takeEarlyStop(laneKey: string): Set<string> | undefined {
  pruneEarlyStops(Date.now())
  const stop = earlyStopsByLane.get(laneKey)
  earlyStopsByLane.delete(laneKey)
  return stop?.targetKeys
}

/** Returned Stop cancels this exact request, or is remembered until it registers. */
export function localGenerationRequestStop(
  operation: TextGenerationOperation,
  identity: SourceControlGenerationRequestIdentity
): (target: GenerationRequestTarget) => void {
  const laneKey = requestLaneKey(operation, identity)
  return (target) => stopLocalGenerationLane(laneKey, target)
}

function stopLocalGenerationLane(laneKey: string, target: GenerationRequestTarget): void {
  const request = cancelTokensByLane.get(laneKey)?.request
  if (request) {
    request.cancelForTarget(target)
    return
  }
  const now = Date.now()
  pruneEarlyStops(now)
  const targetKeys = earlyStopsByLane.get(laneKey)?.targetKeys ?? new Set<string>()
  targetKeys.add(requestTargetKey(target))
  earlyStopsByLane.delete(laneKey)
  earlyStopsByLane.set(laneKey, {
    targetKeys,
    expiresAt: now + SOURCE_CONTROL_GENERATION_TIMEOUT_MS
  })
  for (const oldest of earlyStopsByLane.keys()) {
    if (earlyStopsByLane.size <= MAX_EARLY_STOPS) {
      break
    }
    earlyStopsByLane.delete(oldest)
  }
}

export function aliasLocalGenerationTargetPath(oldCwd: string, newCwd: string): void {
  for (const { request } of cancelTokensByLane.values()) {
    request?.aliasTargetPath(oldCwd, newCwd)
  }
}

export function localGenerationCanceledResult(branchChangedByPreparation?: boolean) {
  return {
    success: false as const,
    error: TEXT_GENERATION_FAILURE_COPY.generationCanceled,
    canceled: true as const,
    ...(branchChangedByPreparation === undefined ? {} : { branchChangedByPreparation })
  }
}

export function localGenerationLaneKey(operation: TextGenerationOperation, cwd: string): string {
  return `${operation}:local:${cwd}`
}

export function cancelLocalGeneration(operation: TextGenerationOperation, cwd: string): void {
  cancelTokensByLane.get(localGenerationLaneKey(operation, cwd))?.cancel?.()
  // Legacy path Stop still cancels every generation on this path.
  for (const { request } of Array.from(cancelTokensByLane.values())) {
    request?.cancelForPath(operation, cwd)
  }
}

export function setLocalGenerationCancelToken(
  laneKey: string,
  cancel: () => void,
  request?: LocalGenerationRequest
): void {
  if (request) {
    request.attachCancelToken(cancel)
  } else {
    cancelTokensByLane.set(laneKey, { cancel })
  }
}

export function clearLocalGenerationCancelToken(
  laneKey: string,
  cancel: () => void,
  request?: LocalGenerationRequest
): void {
  if (request) {
    request.detachCancelToken(cancel)
  } else if (cancelTokensByLane.get(laneKey)?.cancel === cancel) {
    cancelTokensByLane.delete(laneKey)
  }
}

export type TextGenerationRequest = {
  signal: AbortSignal
  cancel: () => void
  validate: () => Promise<boolean>
  deadline: number
  current: () => boolean
  ownsResult: () => boolean
  finish: () => void
  claimSpawn: () => boolean
  remainingSpawns: () => number
}

export function beginTextGenerationRequest(
  operation: TextGenerationOperation,
  cwd: string,
  timeoutMs: number,
  stillOwned: () => boolean,
  validate?: () => Promise<boolean>,
  ownerKey?: string
): TextGenerationRequest {
  // Identified requests pass their exact lane so same-owner generations on one cwd stay independent.
  const key = `${localGenerationLaneKey(operation, cwd)}${ownerKey ? `:owner:${ownerKey}` : ''}`
  cancelTokensByLane.get(key)?.cancel?.()
  const controller = new AbortController()
  const cancel = () => controller.abort('canceled')
  setLocalGenerationCancelToken(key, cancel)
  const maxSpawns = 9
  let spawns = 0
  const deadline = Date.now() + timeoutMs
  const timer = setTimeout(() => controller.abort('deadline'), timeoutMs)
  const ownsResult = () => cancelTokensByLane.get(key)?.cancel === cancel && stillOwned()
  const current = () => !controller.signal.aborted && Date.now() < deadline && ownsResult()
  let validating: Promise<boolean> | undefined
  return {
    cancel,
    // Concurrent callers share one in-flight probe; each still rechecks Stop/ownership on return.
    validate: async () => {
      if (!current()) {
        return false
      }
      // A throwing probe (e.g. git in a removed worktree) means the target is gone: cancel, never reject.
      validating ??= Promise.resolve()
        .then(() => !validate || validate())
        .catch(() => false)
        .finally(() => {
          validating = undefined
        })
      return (await validating) && current()
    },
    claimSpawn: () => ++spawns <= maxSpawns,
    remainingSpawns: () => Math.max(0, maxSpawns - spawns),
    signal: controller.signal,
    deadline,
    current,
    ownsResult,
    finish: () => {
      clearTimeout(timer)
      clearLocalGenerationCancelToken(key, cancel)
    }
  }
}

export function installLocalGenerationCancel(
  operation: TextGenerationOperation,
  cwd: string,
  cancel: () => void,
  request?: TextGenerationRequest,
  registration?: LocalGenerationRequest
): () => void {
  if (request) {
    request.signal.addEventListener('abort', cancel, { once: true })
    return () => request.signal.removeEventListener('abort', cancel)
  }
  const lane = localGenerationLaneKey(operation, cwd)
  setLocalGenerationCancelToken(lane, cancel, registration)
  return () => clearLocalGenerationCancelToken(lane, cancel, registration)
}
