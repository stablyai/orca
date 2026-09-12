import { z } from 'zod'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { SshPtyConsumerRecovery } from '../../../shared/ssh-types'
import { serializeOrcadMigrationValue } from '../../../shared/orcad-migration-manifest'
import { parseOrcadLiveSourceRetirementRecord } from '../../ssh/orcad-live-source-retirement-record'
import { collectOrcadLiveRetirementProfileChanges } from './orcad-live-retirement-profile-changes'
import { assertOrcadLiveSuccessorTabBindingChange } from './orcad-live-successor-tab-binding'

const rows = z.array(z.object({ targetId: z.string() }).passthrough())
const timestamp = z.number().int().nonnegative().safe()
const same = (left: unknown, right: unknown) =>
  serializeOrcadMigrationValue(left) === serializeOrcadMigrationValue(right)

function partition(value: unknown, targetId: string) {
  const parsed = rows.parse(value)
  return {
    target: parsed.filter((row) => row.targetId === targetId),
    other: parsed.filter((row) => row.targetId !== targetId)
  }
}

function assertRecovery(before: unknown, after: unknown, owner: SshPtyConsumerRecovery) {
  const previous = partition(before, owner.targetId)
  const current = partition(after, owner.targetId)
  const original = previous.target[0]
  if (
    previous.target.length !== 1 ||
    current.target.length !== 1 ||
    !same(previous.other, current.other) ||
    !same(current.target[0], owner) ||
    original.clientInstanceId !== owner.clientInstanceId ||
    original.serverBuildId !== owner.serverBuildId ||
    original.ownerLease !== owner.ownerLease ||
    !Number.isSafeInteger(owner.clientGeneration) ||
    !Number.isSafeInteger(owner.ownerGeneration) ||
    !Number.isSafeInteger(original.clientGeneration) ||
    !Number.isSafeInteger(original.ownerGeneration) ||
    Number(original.clientGeneration) <= 0 ||
    Number(original.ownerGeneration) <= 0 ||
    owner.clientGeneration <= Number(original.clientGeneration) ||
    owner.ownerGeneration <= Number(original.ownerGeneration) ||
    !same(
      {
        ...original,
        clientGeneration: owner.clientGeneration,
        ownerGeneration: owner.ownerGeneration,
        outputFlowControl: owner.outputFlowControl
      },
      owner
    )
  ) {
    throw new Error('orcad_live_successor_profile_recovery_conflict')
  }
}

function assertLeases(before: unknown, after: unknown, targetId: string, terminals: Set<string>) {
  const previous = partition(before, targetId)
  const current = partition(after, targetId)
  if (!same(previous.other, current.other) || previous.target.length !== current.target.length) {
    throw new Error('orcad_live_successor_profile_lease_conflict')
  }
  const seen = new Set<string>()
  for (const original of previous.target) {
    const id = z.string().parse(original.ptyId)
    const matches = current.target.filter((row) => row.ptyId === id)
    if (seen.has(id) || matches.length !== 1) {
      throw new Error('orcad_live_successor_profile_lease_conflict')
    }
    seen.add(id)
    const next = matches[0]
    if (!terminals.has(id)) {
      if (!same(original, next)) {
        throw new Error('orcad_live_successor_profile_lease_conflict')
      }
      continue
    }
    if (
      !['attached', 'detached'].includes(String(original.state)) ||
      !['attached', 'detached'].includes(String(next.state)) ||
      original.pendingKill !== undefined ||
      next.pendingKill !== undefined ||
      original.supersededBy !== undefined ||
      original.relayIdRecycled !== undefined ||
      timestamp.parse(next.updatedAt) < timestamp.parse(original.updatedAt)
    ) {
      throw new Error('orcad_live_successor_profile_lease_conflict')
    }
    for (const field of ['lastAttachedAt', 'lastDetachedAt'] as const) {
      if (
        (next[field] === undefined && original[field] !== undefined) ||
        (next[field] !== undefined &&
          (timestamp.parse(next[field]) > Number(next.updatedAt) ||
            timestamp.parse(next[field]) < Number(original[field] ?? 0)))
      ) {
        throw new Error('orcad_live_successor_profile_lease_conflict')
      }
    }
    if (
      !same(
        {
          ...original,
          state: next.state,
          updatedAt: next.updatedAt,
          lastAttachedAt: next.lastAttachedAt,
          lastDetachedAt: next.lastDetachedAt
        },
        next
      )
    ) {
      throw new Error('orcad_live_successor_profile_lease_conflict')
    }
  }
  if ([...terminals].some((id) => !seen.has(id))) {
    throw new Error('orcad_live_successor_profile_lease_conflict')
  }
}

/** Comparison only: caller retains native exclusion, complete cancellation and exact resumed owner. */
export function assertOrcadLiveSuccessorProfileChanges(options: {
  state: PersistedState
  candidate: PersistedState
  record: unknown
  owner: SshPtyConsumerRecovery
}) {
  const record = parseOrcadLiveSourceRetirementRecord(options.record)
  const targetId = record.release.cutover.manifest.source.sshTargetId
  if (options.owner.targetId !== targetId) {
    throw new Error('orcad_live_successor_profile_target_conflict')
  }
  if (
    record.release.cutover.liveTerminalBindings!.some(
      ({ identity }) =>
        identity.ownerLease !== options.owner.ownerLease ||
        identity.sourceOwnerGeneration >= options.owner.ownerGeneration
    )
  ) {
    throw new Error('orcad_live_successor_profile_recovery_conflict')
  }
  const actual = collectOrcadLiveRetirementProfileChanges(options.state, options.candidate)
  if (actual.length !== record.changes.length) {
    throw new Error('orcad_live_successor_profile_candidate_conflict')
  }
  const terminals = new Set(
    record.release.cutover.liveTerminalBindings!.map(({ identity }) => identity.terminalId)
  )
  for (const expected of record.changes) {
    const change = actual.find((entry) => entry.field === expected.field)
    if (!change || change.after !== expected.after) {
      throw new Error('orcad_live_successor_profile_candidate_conflict')
    }
    if (expected.field === 'sshPtyConsumerRecoveries') {
      assertRecovery(
        JSON.parse(expected.before!),
        options.state.sshPtyConsumerRecoveries,
        options.owner
      )
    } else if (expected.field === 'sshRemotePtyLeases') {
      assertLeases(
        JSON.parse(expected.before!),
        options.state.sshRemotePtyLeases,
        targetId,
        terminals
      )
    } else if (
      expected.field === 'workspaceSession' ||
      expected.field === 'workspaceSessionsByHostId'
    ) {
      assertOrcadLiveSuccessorTabBindingChange(
        expected.before,
        change.before,
        expected.field,
        record.release.cutover
      )
    } else if (change.before !== expected.before) {
      throw new Error('orcad_live_successor_profile_before_conflict')
    }
  }
}
