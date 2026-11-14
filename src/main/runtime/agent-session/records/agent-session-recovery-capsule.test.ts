import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  marker,
  NOW,
  SESSION
} from '../../../native-chat/agent-session-wire/recovery/testing/structured-agent-session-restart-resume-test-harness'
import {
  AgentSessionRecoveryCapsule,
  AGENT_SESSION_RECOVERY_CAPSULE_FILE
} from './agent-session-recovery-capsule'
import type { AgentSessionResumeFailureInput } from './agent-session-recovery-capsule-entries'

let directory: string
let filePath: string
let capsule: AgentSessionRecoveryCapsule

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-recovery-capsule-'))
  filePath = join(directory, AGENT_SESSION_RECOVERY_CAPSULE_FILE)
  capsule = new AgentSessionRecoveryCapsule(directory)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(directory, { recursive: true, force: true })
})

function failure(
  overrides: Partial<AgentSessionResumeFailureInput> = {}
): AgentSessionResumeFailureInput {
  return {
    sessionId: SESSION,
    failedAt: NOW,
    outcome: 'refused',
    reason: 'agent_session_restart_work_superseded',
    latestPrompt: '',
    latestUserItemId: 'user-after-failure',
    ...overrides
  }
}

async function fileFailure(overrides: Partial<AgentSessionResumeFailureInput> = {}) {
  await capsule.beginResume([SESSION], 'operation-a', NOW)
  await capsule.failResume('operation-a', [failure(overrides)], NOW)
}

describe('durable restart offers', () => {
  it('reserves only one copy of a selected session across competing owners', async () => {
    await capsule.record([marker(), marker({ sessionId: 'second' })], NOW)
    const other = new AgentSessionRecoveryCapsule(directory)

    const results = await Promise.allSettled([
      capsule.beginResume([SESSION], 'operation-a', NOW),
      other.beginResume([SESSION], 'operation-b', NOW)
    ])
    const selected = results.flatMap((result) =>
      result.status === 'fulfilled' ? result.value : []
    )

    // File locking serializes admission; the second action sees the first reservation.
    expect(selected).toHaveLength(1)
    expect(await capsule.list(NOW)).toEqual([marker({ sessionId: 'second' })])
  })

  it('only files failures for the operation that owns the reservation', async () => {
    await capsule.record([marker()], NOW)
    await capsule.beginResume([SESSION], 'operation-a', NOW)
    await capsule.failResume('operation-b', [failure()], NOW)
    expect(await capsule.listFailed(NOW)).toEqual([])
    await capsule.rollbackResume('operation-a', NOW)
    expect(await capsule.list(NOW)).toEqual([marker()])
  })

  it('forgets a superseded failure only while it is the one that was read', async () => {
    await capsule.record([marker()], NOW)
    await fileFailure()

    await capsule.forgetSuperseded(
      [{ sessionId: SESSION, recordedAt: NOW, failedAt: NOW - 1 }],
      NOW
    )
    expect(await capsule.listFailed(NOW)).toHaveLength(1)
    await capsule.forgetSuperseded([{ sessionId: SESSION, recordedAt: NOW, failedAt: NOW }], NOW)
    expect(await capsule.listFailed(NOW)).toEqual([])
  })

  // New user messages invalidate only the observed witness; preserve later teardown records.
  it('forgets a superseded pending offer only for the witness that was read', async () => {
    await capsule.record([marker()], NOW)

    await capsule.forgetSuperseded([{ sessionId: SESSION, recordedAt: NOW - 1 }], NOW)
    expect(await capsule.list(NOW)).toHaveLength(1)
    await capsule.forgetSuperseded([{ sessionId: SESSION, recordedAt: NOW }], NOW)
    expect(await capsule.list(NOW)).toEqual([])
  })

  // Older parsers reject new entry states but ignore unknown top-level keys; store failures separately.

  // Downgrade must skip unknown failures without losing offers or blocking newer teardowns.

  it('does not let another operation complete or roll back an active reservation', async () => {
    await capsule.record([marker()], NOW)
    await capsule.beginResume([SESSION], 'operation-a', NOW)

    await capsule.completeResume('operation-b', [SESSION], NOW)
    await capsule.rollbackResume('operation-b', NOW)
    expect(await capsule.list(NOW)).toEqual([])

    await capsule.rollbackResume('operation-a', NOW)
    expect(await capsule.list(NOW)).toEqual([marker()])
  })

  it('keeps a newer same-session teardown behind an active reservation', async () => {
    const newer = marker({
      teardownId: 'teardown-new',
      recordedAt: NOW + 1,
      work: { kind: 'turn', id: 'turn-new' }
    })
    await capsule.record([marker()], NOW)
    await capsule.beginResume([SESSION], 'operation-a', NOW)
    await capsule.record([newer], NOW + 1)

    expect(await capsule.list(NOW + 1)).toEqual([])
    await capsule.rollbackResume('operation-a', NOW + 1)
    expect(await capsule.list(NOW + 1)).toEqual([newer])

    await capsule.beginResume([SESSION], 'operation-b', NOW)
    await capsule.completeResume('operation-b', [SESSION], NOW)
    expect(await capsule.list(NOW)).toEqual([])
  })

  it('fences a late teardown write until a genuinely newer interruption', async () => {
    await capsule.record([marker()], NOW)
    await capsule.clearAll(NOW + 1)

    // Model a teardown callback outliving another host's timed phase.
    await capsule.record([marker()], NOW + 1)
    expect(await capsule.list(NOW + 1)).toEqual([])

    const newer = marker({ recordedAt: NOW + 2, teardownId: 'teardown-new' })
    await capsule.record([newer], NOW + 2)
    expect(await capsule.list(NOW + 2)).toEqual([newer])

    // New interruptions must preserve the fence against older delayed callbacks.
    await capsule.record([marker()], NOW + 2)
    expect(await capsule.list(NOW + 2)).toEqual([newer])
  })

  it('preserves unreadable bytes on list and ordinary writes', async () => {
    const corrupt = '{"version":2,"entries":[{"state":"pending"}]}'
    await writeFile(filePath, corrupt)

    await expect(capsule.list(NOW)).rejects.toThrow()
    await expect(capsule.record([marker()], NOW)).rejects.toThrow()
    expect(await readFile(filePath, 'utf8')).toBe(corrupt)
  })

  it('fails closed on duplicate session records instead of allowing a second resume', async () => {
    const duplicate = JSON.stringify({
      version: 2,
      entries: [
        { state: 'in-progress', operationId: 'operation-a', startedAt: NOW, marker: marker() },
        { state: 'pending', marker: marker({ teardownId: 'duplicate' }) }
      ]
    })
    await writeFile(filePath, duplicate)

    await expect(capsule.list(NOW)).rejects.toThrow('duplicate_session')
    expect(await readFile(filePath, 'utf8')).toBe(duplicate)
  })

  // Offers expire only by user action, never TTL or clock drift.
})
