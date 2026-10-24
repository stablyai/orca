import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import {
  isSameAgentProcess,
  readAgentProcessIdentity,
  type AgentProcessIdentity
} from '../../../shared/agent-process-presence'

export type TerminalMailTarget = {
  paneKey: string
  process: AgentProcessIdentity
  owner: string
  turnKey: string
}

export function openTerminalMailTarget(
  row: AgentHookEventPayload | undefined
): TerminalMailTarget | null {
  return row?.restoredUnconfirmed || row?.agentPresence?.ended || row?.providerSessionOnly
    ? null
    : historicalTerminalMailTarget(row)
}

function historicalTerminalMailTarget(
  row: AgentHookEventPayload | undefined
): TerminalMailTarget | null {
  const turn = row?.hostTurn
  const process = row?.agentPresence?.process
  if (
    !row ||
    row.connectionId !== null ||
    !process ||
    !turn ||
    turn.currentTurnKey === 'seed' ||
    turn.completed?.turnKey === turn.currentTurnKey ||
    row.payload.mainAgent?.state !== 'working' ||
    row.payload.mainAgent.stopping
  ) {
    return null
  }
  return { paneKey: row.paneKey, process, owner: turn.owner, turnKey: turn.currentTurnKey }
}

export function sameTerminalMailTarget(a: TerminalMailTarget, b: TerminalMailTarget): boolean {
  return (
    a.paneKey === b.paneKey &&
    a.owner === b.owner &&
    a.turnKey === b.turnKey &&
    isSameAgentProcess(a.process, b.process)
  )
}

export function readTerminalMailTarget(value: unknown): TerminalMailTarget | null {
  if (
    !value ||
    typeof value !== 'object' ||
    !('paneKey' in value) ||
    typeof value.paneKey !== 'string' ||
    !('owner' in value) ||
    typeof value.owner !== 'string' ||
    !('turnKey' in value) ||
    typeof value.turnKey !== 'string' ||
    !('process' in value)
  ) {
    return null
  }
  const process = readAgentProcessIdentity(value.process)
  return process
    ? { paneKey: value.paneKey, owner: value.owner, turnKey: value.turnKey, process }
    : null
}

export class TerminalMailTargets {
  private readonly abandoned = new Map<string, TerminalMailTarget>()
  private readonly retired = new Map<string, TerminalMailTarget>()
  private readonly examined = new WeakSet<AgentHookEventPayload>()

  read = openTerminalMailTarget

  observeRow(
    before: AgentHookEventPayload | null | undefined,
    after: AgentHookEventPayload | null | undefined
  ): void {
    if (!after) {
      return
    }
    if (before && this.examined.has(before)) {
      this.examined.add(after)
    }
    const key = before?.paneKey ?? after.paneKey
    const proof = this.abandoned.get(key) ?? historicalTerminalMailTarget(before ?? undefined)
    if (!proof) {
      return
    }
    const turn = after.hostTurn
    if (
      (before &&
        (before.connectionId !== after.connectionId || before.worktreeId !== after.worktreeId)) ||
      after.payload.mainAgent?.outcome === 'cancellation' ||
      after.payload.mainAgent?.stopping ||
      (turn &&
        turn.currentTurnKey !== 'seed' &&
        (turn.owner !== proof.owner ||
          turn.currentTurnKey !== proof.turnKey ||
          turn.completed?.turnKey === proof.turnKey))
    ) {
      this.abandoned.delete(key)
      this.retired.set(JSON.stringify(proof), proof)
      if (before) {
        this.examined.add(before)
      }
      this.examined.add(after)
      const oldest = this.retired.keys().next().value
      if (this.retired.size > 256 && oldest !== undefined) {
        this.retired.delete(oldest)
      }
    } else if (key !== after.paneKey && this.abandoned.delete(key)) {
      this.abandoned.set(after.paneKey, { ...proof, paneKey: after.paneKey })
    }
  }

  observeExit(
    row: AgentHookEventPayload | undefined,
    process: AgentProcessIdentity | undefined
  ): void {
    const target = this.read(row)
    if (!target || !process || !isSameAgentProcess(target.process, process)) {
      return
    }
    if (this.retired.has(JSON.stringify(target))) {
      return
    }
    if (row) {
      this.examined.add(row)
    }
    this.remember(target)
  }

  private remember(target: TerminalMailTarget): void {
    this.abandoned.set(target.paneKey, target)
    if (this.abandoned.size > 256) {
      const oldest = this.abandoned.keys().next().value
      if (oldest !== undefined) {
        this.abandoned.delete(oldest)
      }
    }
  }

  wasAbandoned(
    target: TerminalMailTarget,
    row: AgentHookEventPayload | undefined,
    exit: AgentProcessIdentity | undefined
  ): boolean {
    this.observeRow(undefined, row)
    if (this.retired.has(JSON.stringify(target))) {
      return false
    }
    const turn = row?.hostTurn
    if (row?.payload.mainAgent?.outcome === 'cancellation') {
      return false
    }
    if (
      turn &&
      turn.currentTurnKey !== 'seed' &&
      (turn.owner !== target.owner ||
        turn.currentTurnKey !== target.turnKey ||
        turn.completed?.turnKey === target.turnKey)
    ) {
      return false
    }
    const proof = this.abandoned.get(target.paneKey)
    if (proof && sameTerminalMailTarget(proof, target)) {
      return true
    }
    if (!row || this.examined.has(row)) {
      return false
    }
    const retained = historicalTerminalMailTarget(row)
    const proven = Boolean(
      row?.providerSessionOnly &&
      row.agentPresence?.ended &&
      retained &&
      exit &&
      sameTerminalMailTarget(retained, target) &&
      isSameAgentProcess(exit, target.process)
    )
    if (proven) {
      this.examined.add(row)
      this.remember(target)
    }
    return proven
  }
}
