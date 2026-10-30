import {
  PreparedAgentLaunchExecution,
  PREPARED_LAUNCH_CALLER_KEY,
  type LaunchWork
} from './prepared-agent-launch-execution'
import {
  validatePreparedAgentSpawn,
  fingerprintPreparedAgentLaunch,
  copyPreparedAgentSpawn
} from './prepared-agent-launch-payload'
import { randomUUID } from 'node:crypto'
import {
  agentSessionOperationKey,
  claimAgentSessionOperation,
  evaluateAgentSessionOperation,
  pruneAgentSessionOperationRows
} from '../../shared/agent-session-operation-ledger'
import {
  isAgentSessionExecutionClaim,
  isAgentSessionSurfaceBinding
} from '../../shared/agent-session-host-authority'
import type {
  PreparedAgentLaunchIdentity,
  PreparedAgentLaunchRequest,
  PreparedAgentLaunchStatus
} from './prepared-agent-launch-protocol'

const PREPARATION_TTL_MS = 60_000
const SETUP_DEADLINE_MS = 2 * 60 * 60_000
const CALLER_KEY = PREPARED_LAUNCH_CALLER_KEY

export class PreparedAgentLaunchOwner extends PreparedAgentLaunchExecution {
  readonly generation = randomUUID()
  private readonly work = new Map<string, LaunchWork>()

  get pending(): number {
    let count = 0
    for (const { status, prompts } of this.work.values()) {
      if (
        status.retirement !== 'unused-retired' &&
        (status.execution === 'unknown' ||
          status.execution === 'not-dispatched' ||
          status.execution === 'dispatching' ||
          !status.published ||
          prompts !== undefined)
      ) {
        count++
      }
    }
    return count
  }

  async handle(payload: PreparedAgentLaunchRequest['payload']): Promise<unknown> {
    if (payload.action === 'prepare') {
      return this.prepare(payload)
    }
    if (payload.action === 'list') {
      const limit = Math.max(1, Math.min(100, payload.limit ?? 50))
      const entries = [...this.work.keys()]
        .sort()
        .filter((id) => !payload.after || id > payload.after)
      return {
        operations: entries.slice(0, limit).map((id) => this.snapshot(this.requireWork(id))),
        ...(entries.length > limit ? { after: entries[limit - 1] } : {})
      }
    }
    const work = this.requireIdentity(payload.identity)
    switch (payload.action) {
      case 'accept':
        return this.accept(work, payload)
      case 'status':
        return this.snapshot(work)
      case 'cancel':
        this.retireUnstarted(work, 'cancelled')
        return this.snapshot(work)
      case 'ackPublication':
        work.status.published = true
        this.notify(work)
        return this.snapshot(work)
      case 'claimPrompt': {
        if (!work.status.published || work.promptClaimed || !work.prompts) {
          return null
        }
        work.promptClaimed = true
        return structuredClone(work.prompts)
      }
      case 'settlePrompt':
        if (work.promptClaimed) {
          work.prompts = undefined
        }
        return this.snapshot(work)
      case 'retireInput':
        if (
          work.status.retirement === 'unused-retired' ||
          (work.status.physical && work.status.published && !work.prompts)
        ) {
          work.status.retirement = 'unused-retired'
          work.launch = undefined
          const row = this.rows.get(agentSessionOperationKey(CALLER_KEY, work.status.operationId))
          if (row) {
            delete row.preparedLaunch
          }
        }
        return this.snapshot(work)
      case 'wait':
        return this.wait(work, payload.timeoutMs, payload.until)
    }
  }

  private async prepare(
    payload: Extract<PreparedAgentLaunchRequest['payload'], { action: 'prepare' }>
  ) {
    if (
      !isAgentSessionExecutionClaim(payload.claim) ||
      !isAgentSessionSurfaceBinding(payload.surface)
    ) {
      throw new Error('agent_session_identity_required')
    }
    this.rows = pruneAgentSessionOperationRows(this.rows, this.now())
    for (const [id, work] of this.work) {
      if (
        !this.rows.has(agentSessionOperationKey(CALLER_KEY, id)) &&
        work.status.retirement === 'unused-retired'
      ) {
        this.work.delete(id)
      }
    }
    const decision = evaluateAgentSessionOperation({
      rows: this.rows,
      callerKey: CALLER_KEY,
      ...payload,
      now: this.now()
    })
    if (decision.decision === 'refused') {
      throw new Error(decision.code)
    }
    if (decision.decision === 'replay') {
      return this.snapshot(this.requireWork(payload.operationId))
    }
    const preparation = this.deps.owners.prepare({
      claim: payload.claim,
      surface: payload.surface,
      isLive: (owner) => this.deps.isAlive(owner.ptyId)
    })
    const prepared = preparation instanceof Promise ? await preparation : preparation
    // A new operation cannot take input or lifetime authority from another operation's reservation.
    if (prepared.phase !== 'reserved' || !prepared.created) {
      throw new Error('agent_session_conflict')
    }
    const status: PreparedAgentLaunchStatus = {
      operationId: payload.operationId,
      fingerprint: payload.fingerprint,
      daemonGeneration: this.generation,
      reservationGeneration: prepared.owner.generation,
      claim: prepared.owner.claim,
      surface: prepared.owner.surface,
      accepted: false,
      execution: 'not-dispatched',
      retirement: 'retained-pending',
      published: false
    }
    const work: LaunchWork = {
      owner: prepared.owner,
      status,
      changed: new Set(),
      physicalEnded: false
    }
    decision.row.preparedLaunch = {
      daemonGeneration: this.generation,
      reservationGeneration: prepared.owner.generation
    }
    this.rows.set(agentSessionOperationKey(CALLER_KEY, payload.operationId), decision.row)
    this.work.set(payload.operationId, work)
    const timer = setTimeout(() => this.retireUnstarted(work, 'expired'), PREPARATION_TTL_MS)
    timer.unref()
    work.cancelDeadline = () => clearTimeout(timer)
    return this.snapshot(work)
  }

  private accept(
    work: LaunchWork,
    payload: Extract<PreparedAgentLaunchRequest['payload'], { action: 'accept' }>
  ) {
    if (work.status.accepted || work.status.retirement === 'unused-retired') {
      return this.snapshot(work)
    }
    if (fingerprintPreparedAgentLaunch(payload) !== work.status.fingerprint) {
      throw new Error('agent_session_operation_conflict')
    }
    validatePreparedAgentSpawn(payload.launch)
    if (payload.setup) {
      validatePreparedAgentSpawn(payload.setup.spawn)
      if (
        !/^[0-9a-f-]{36}$/.test(payload.setup.attemptId) ||
        !Number.isSafeInteger(payload.setup.deadline)
      ) {
        throw new Error('agent_session_operation_invalid')
      }
      if (
        payload.setup.deadline <= this.now() ||
        payload.setup.deadline > this.now() + SETUP_DEADLINE_MS
      ) {
        throw new Error('agent_session_operation_expired')
      }
      if (payload.setup.spawn.sessionId === payload.launch.sessionId) {
        throw new Error('agent_session_conflict')
      }
    }
    const launch = copyPreparedAgentSpawn(payload.launch)
    const setupPayload = payload.setup
      ? { ...payload.setup, spawn: copyPreparedAgentSpawn(payload.setup.spawn) }
      : undefined
    const prompts = payload.prompts ? structuredClone(payload.prompts) : undefined
    const capacity = this.deps.reserveCapacity()
    const claimed = claimAgentSessionOperation(this.rows, {
      callerKey: CALLER_KEY,
      operationId: work.status.operationId,
      now: this.now()
    })
    if (claimed.claim.claim !== 'won') {
      capacity()
      throw new Error('agent_session_operation_expired')
    }
    this.rows = claimed.rows
    work.cancelDeadline?.()
    work.status.accepted = true
    work.launch = launch
    work.prompts = prompts
    work.releaseCapacity = capacity
    // Copy the complete accepted payload before starting either physical process.
    if (setupPayload) {
      const setup = setupPayload
      work.status.setup = { sessionId: setup.spawn.sessionId }
      const timer = setTimeout(
        () => this.retireUnstarted(work, 'setup-timeout'),
        setup.deadline - this.now()
      )
      timer.unref()
      work.cancelDeadline = () => clearTimeout(timer)
      void this.startSetup(work, setup)
    } else {
      void this.dispatch(work)
    }
    return this.snapshot(work)
  }

  private requireIdentity(identity: PreparedAgentLaunchIdentity): LaunchWork {
    const work = this.requireWork(identity.operationId)
    if (
      identity.daemonGeneration !== this.generation ||
      identity.reservationGeneration !== work.owner.generation ||
      identity.fingerprint !== work.status.fingerprint
    ) {
      throw new Error('agent_session_ownership_unknown')
    }
    return work
  }

  private requireWork(operationId: string): LaunchWork {
    const work = this.work.get(operationId)
    if (!work) {
      throw new Error('agent_session_operation_unknown')
    }
    return work
  }

  private snapshot(work: LaunchWork): PreparedAgentLaunchStatus {
    return structuredClone(work.status)
  }

  protected notify(work: LaunchWork): void {
    for (const changed of work.changed) {
      changed()
    }
  }

  private wait(
    work: LaunchWork,
    requestedMs: number,
    until: 'setup' | 'launch' = 'launch'
  ): Promise<PreparedAgentLaunchStatus> {
    const ready = () =>
      (until === 'setup' && work.status.setup?.incarnationId !== undefined) ||
      (work.status.execution !== 'not-dispatched' && work.status.execution !== 'dispatching')
    if (ready()) {
      return Promise.resolve(this.snapshot(work))
    }
    return new Promise((resolve) => {
      const done = () => {
        if (!ready()) {
          return
        }
        finish()
      }
      const finish = () => {
        clearTimeout(timer)
        work.changed.delete(done)
        resolve(this.snapshot(work))
      }
      const timer = setTimeout(finish, Math.max(1, Math.min(10_000, requestedMs)))
      work.changed.add(done)
    })
  }
}
