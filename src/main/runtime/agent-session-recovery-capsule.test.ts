import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import * as durable from '../durable-file-write'
import {
  marker,
  NOW,
  SESSION
} from '../native-chat/agent-session-wire/structured-agent-session-restart-resume-test-harness'
import {
  AgentSessionRecoveryCapsule,
  AGENT_SESSION_RECOVERY_CAPSULE_FILE,
  type AgentSessionResumeFailureInput
} from './agent-session-recovery-capsule'

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

function failPublish() {
  return vi.spyOn(durable, 'renameDurable').mockRejectedValueOnce(new Error('publish unavailable'))
}

describe('durable restart offers', () => {
  it('lists without spending or rewriting the durable records', async () => {
    const markers = [marker(), marker({ sessionId: 'second' })]
    await capsule.record(markers, NOW)
    const before = await readFile(filePath)

    expect(await capsule.list(NOW)).toEqual(markers)
    expect(await capsule.list(NOW)).toEqual(markers)
    expect(await readFile(filePath)).toEqual(before)
  })

  it('merges fresh teardown markers with existing offers by session', async () => {
    const replacement = marker({ teardownId: 'teardown-new', recordedAt: NOW + 1 })
    await capsule.record([marker(), marker({ sessionId: 'second' })], NOW)
    await capsule.record([replacement], NOW + 1)

    expect(await capsule.list(NOW + 1)).toEqual([replacement, marker({ sessionId: 'second' })])
  })

  it('does not let a late older teardown replace a newer offer', async () => {
    const older = marker({ recordedAt: NOW })
    const newer = marker({ recordedAt: NOW + 1, teardownId: 'teardown-new' })
    await capsule.record([newer], NOW + 1)
    await capsule.record([older], NOW + 1)

    expect(await capsule.list(NOW + 1)).toEqual([newer])
  })

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

    // Bounded lock retries serialize the two mutations; one owner wins and the other observes an
    // empty selection after the winner publishes its reservation.
    expect(selected).toHaveLength(1)
    expect(await capsule.list(NOW)).toEqual([marker({ sessionId: 'second' })])
  })

  it('deletes only completed sessions and leaves unrelated offers', async () => {
    await capsule.record([marker(), marker({ sessionId: 'second' })], NOW)
    const reserved = await capsule.beginResume([SESSION], 'operation-a', NOW)
    expect(reserved).toEqual([marker()])

    await capsule.completeResume('operation-a', [SESSION], NOW)

    expect(await capsule.list(NOW)).toEqual([marker({ sessionId: 'second' })])
  })

  it('files an acted-on session whose agent did not carry on as a durable failure', async () => {
    await capsule.record([marker(), marker({ sessionId: 'second' })], NOW)
    await capsule.beginResume([SESSION], 'operation-a', NOW)

    await capsule.failResume(
      'operation-a',
      [
        failure({
          failedAt: NOW + 5,
          reason: 'agent_session_restart_work_superseded',
          latestPrompt: 'fix the auth bug'
        })
      ],
      NOW + 5
    )

    // No longer an offer, but still on record with what went wrong.
    expect(await capsule.list(NOW + 5)).toEqual([marker({ sessionId: 'second' })])
    expect(await capsule.listFailed(NOW + 5)).toEqual([
      {
        marker: marker(),
        failedAt: NOW + 5,
        outcome: 'refused',
        reason: 'agent_session_restart_work_superseded',
        latestPrompt: 'fix the auth bug',
        latestUserItemId: 'user-after-failure'
      }
    ])
    // Still there after the operation's own rollback: a failure is settled, not reopened.
    await capsule.rollbackResume('operation-a', NOW + 5)
    expect(await capsule.list(NOW + 5)).toEqual([marker({ sessionId: 'second' })])
    expect(await capsule.listFailed(NOW + 5)).toHaveLength(1)
  })

  it('only files failures for the operation that owns the reservation', async () => {
    await capsule.record([marker()], NOW)
    await capsule.beginResume([SESSION], 'operation-a', NOW)
    await capsule.failResume('operation-b', [failure()], NOW)
    expect(await capsule.listFailed(NOW)).toEqual([])
    await capsule.rollbackResume('operation-a', NOW)
    expect(await capsule.list(NOW)).toEqual([marker()])
  })

  it('retries a failure only when the action names it, and a success removes it', async () => {
    await capsule.record([marker(), marker({ sessionId: 'second' })], NOW)
    await fileFailure()

    // Resume-all must not silently re-run what already failed.
    expect(await capsule.beginResume(undefined, 'operation-b', NOW)).toEqual([
      marker({ sessionId: 'second' })
    ])
    await capsule.rollbackResume('operation-b', NOW)
    // Naming it is a retry. The failure stays on record until the retry settles.
    expect(await capsule.beginResume([SESSION], 'operation-c', NOW)).toEqual([marker()])
    expect(await capsule.listFailed(NOW)).toHaveLength(1)
    await capsule.completeResume('operation-c', [SESSION], NOW)
    expect(await capsule.listFailed(NOW)).toEqual([])
    expect(await capsule.list(NOW)).toEqual([marker({ sessionId: 'second' })])
  })

  it('keeps a retried failure a failure when the retry rolls back or its lease lapses', async () => {
    await capsule.record([marker()], NOW)
    await fileFailure()

    await capsule.beginResume([SESSION], 'operation-b', NOW)
    await capsule.rollbackResume('operation-b', NOW)
    expect(await capsule.list(NOW)).toEqual([])
    expect(await capsule.listFailed(NOW)).toHaveLength(1)
    expect(await capsule.beginResume(undefined, 'operation-c', NOW)).toEqual([])

    await capsule.beginResume([SESSION], 'operation-d', NOW)
    const later = NOW + 10 * 60 * 1000 + 1
    expect(await capsule.list(later)).toEqual([])
    expect(await capsule.beginResume(undefined, 'operation-e', later)).toEqual([])
    expect(await capsule.listFailed(later)).toHaveLength(1)
  })

  it('refiles a failed retry with its new reason', async () => {
    await capsule.record([marker()], NOW)
    await fileFailure()
    await capsule.beginResume([SESSION], 'operation-b', NOW + 1)
    await capsule.failResume(
      'operation-b',
      [failure({ failedAt: NOW + 1, reason: 'agent_session_conflict' })],
      NOW + 1
    )

    expect(await capsule.listFailed(NOW + 1)).toMatchObject([
      { failedAt: NOW + 1, reason: 'agent_session_conflict' }
    ])
  })

  it('lets a newer teardown of the same chat supersede its recorded failure', async () => {
    await capsule.record([marker()], NOW)
    await fileFailure({ outcome: 'unconfirmed', reason: 'pending' })
    // A late writer of an older or the same witness does not.
    await capsule.record([marker()], NOW)
    expect(await capsule.list(NOW)).toEqual([])
    expect(await capsule.listFailed(NOW)).toHaveLength(1)

    const newer = marker({ recordedAt: NOW + 1, teardownId: 'teardown-new' })
    await capsule.record([newer], NOW + 1)

    expect(await capsule.list(NOW + 1)).toEqual([newer])
    expect(await capsule.listFailed(NOW + 1)).toEqual([])
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

  // The user's own send ends a pending offer the same way it ends a failure record — the record
  // is deleted, witness-keyed so a marker a newer teardown wrote meanwhile survives.
  it('forgets a superseded pending offer only for the witness that was read', async () => {
    await capsule.record([marker()], NOW)

    await capsule.forgetSuperseded([{ sessionId: SESSION, recordedAt: NOW - 1 }], NOW)
    expect(await capsule.list(NOW)).toHaveLength(1)
    await capsule.forgetSuperseded([{ sessionId: SESSION, recordedAt: NOW }], NOW)
    expect(await capsule.list(NOW)).toEqual([])
  })

  // A reserved row belongs to its action, which settles it itself.
  it('does not forget an in-progress reservation as superseded', async () => {
    await capsule.record([marker()], NOW)
    await capsule.beginResume([SESSION], 'operation-a', NOW)

    await capsule.forgetSuperseded([{ sessionId: SESSION, recordedAt: NOW }], NOW)

    await capsule.rollbackResume('operation-a', NOW)
    expect(await capsule.list(NOW)).toEqual([marker()])
  })

  it('forgets named records of any state and reports how many went', async () => {
    await capsule.record(
      [marker(), marker({ sessionId: 'second' }), marker({ sessionId: 'third' })],
      NOW
    )
    await fileFailure()
    const before = await readFile(filePath)

    expect(await capsule.dismiss([SESSION, 'second', 'missing'], NOW)).toBe(2)
    expect(await capsule.list(NOW)).toEqual([marker({ sessionId: 'third' })])
    expect(await capsule.listFailed(NOW)).toEqual([])
    // Nothing named, nothing rewritten.
    expect(await capsule.dismiss(['missing'], NOW)).toBe(0)
    expect(await readFile(filePath)).not.toEqual(before)
    // Not a fence: the same chat may be offered again by a later teardown.
    await capsule.record([marker()], NOW)
    expect(await capsule.list(NOW)).toEqual([marker({ sessionId: 'third' }), marker()])
  })

  // A failure record has no expiry either; it ends only with the user's own actions.
  it('keeps a months-old failure on record', async () => {
    await capsule.record([marker()], NOW)
    await fileFailure()
    expect(await capsule.listFailed(NOW + 90 * 24 * 60 * 60 * 1000)).toHaveLength(1)
  })

  // An older build parses entries with a two-state enum and throws on anything else, which would
  // cost it every offer. Its schema ignores unknown top-level keys, so failures live under one.
  it('writes failures in a file an older build still reads its offers from', async () => {
    const olderEntry = z.object({
      state: z.enum(['pending', 'in-progress']),
      operationId: z.string().min(1).optional(),
      startedAt: z.number().int().nonnegative().optional(),
      marker: z.unknown(),
      replacement: z.unknown().optional()
    })
    const olderCapsule = z.object({
      version: z.literal(2),
      entries: z.array(z.unknown()),
      dismissedAt: z.number().int().nonnegative().optional()
    })
    const olderStates = async () =>
      olderCapsule
        .parse(JSON.parse(await readFile(filePath, 'utf8')))
        .entries.map((entry) => olderEntry.parse(entry).state)
    await capsule.record([marker(), marker({ sessionId: 'second' })], NOW)

    await fileFailure()
    expect(await olderStates()).toEqual(['pending'])
    await capsule.beginResume([SESSION], 'operation-retry', NOW)
    expect((await olderStates()).sort()).toEqual(['in-progress', 'pending'])
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toMatchObject({
      failed: [{ marker: { sessionId: SESSION } }]
    })
  })

  // A newer build may file a failure shape this one cannot parse; after a downgrade that must not
  // cost the offers or block recording new teardowns.
  it('skips a failure record it cannot read instead of rejecting the whole file', async () => {
    const readable = {
      marker: marker(),
      failedAt: NOW,
      outcome: 'refused',
      reason: 'agent_session_restart_work_superseded',
      latestPrompt: '',
      latestUserItemId: null
    }
    await writeFile(
      filePath,
      JSON.stringify({
        version: 2,
        entries: [{ state: 'pending', marker: marker({ sessionId: 'second' }) }],
        failed: [
          { ...readable, marker: marker({ sessionId: 'future' }), outcome: 'later-outcome' },
          { ...readable, marker: { ...marker({ sessionId: 'future-marker' }), trigger: 'later' } },
          readable
        ]
      })
    )

    expect(await capsule.list(NOW)).toEqual([marker({ sessionId: 'second' })])
    expect(await capsule.listFailed(NOW)).toEqual([readable])
    await capsule.record([marker({ sessionId: 'third' })], NOW)
    expect(await capsule.list(NOW)).toEqual([
      marker({ sessionId: 'second' }),
      marker({ sessionId: 'third' })
    ])
    expect(await capsule.listFailed(NOW)).toEqual([readable])
    expect(JSON.parse(await readFile(filePath, 'utf8')).failed).toEqual([readable])
  })

  it('reads a malformed failure list as no failures', async () => {
    await writeFile(
      filePath,
      JSON.stringify({
        version: 2,
        entries: [{ state: 'pending', marker: marker() }],
        failed: { unexpected: true }
      })
    )

    expect(await capsule.list(NOW)).toEqual([marker()])
    expect(await capsule.listFailed(NOW)).toEqual([])
    await capsule.record([marker({ sessionId: 'second' })], NOW)
    expect(await capsule.list(NOW)).toEqual([marker(), marker({ sessionId: 'second' })])
  })

  it('rolls a failed acquisition back to a pending offer', async () => {
    await capsule.record([marker()], NOW)
    await capsule.beginResume([SESSION], 'operation-a', NOW)
    expect(await capsule.list(NOW)).toEqual([])

    await capsule.rollbackResume('operation-a', NOW)

    expect(await capsule.list(NOW)).toEqual([marker()])
  })

  it('does not let another operation complete or roll back an active reservation', async () => {
    await capsule.record([marker()], NOW)
    await capsule.beginResume([SESSION], 'operation-a', NOW)

    await capsule.completeResume('operation-b', [SESSION], NOW)
    await capsule.rollbackResume('operation-b', NOW)
    expect(await capsule.list(NOW)).toEqual([])

    await capsule.rollbackResume('operation-a', NOW)
    expect(await capsule.list(NOW)).toEqual([marker()])
  })

  it('preserves an active reservation when teardown records another session', async () => {
    await capsule.record([marker()], NOW)
    await capsule.beginResume([SESSION], 'operation-a', NOW)
    await capsule.record([marker({ sessionId: 'second' })], NOW)

    expect(await capsule.list(NOW)).toEqual([marker({ sessionId: 'second' })])
    const raw = JSON.parse(await readFile(filePath, 'utf8'))
    expect(raw.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: 'in-progress',
          operationId: 'operation-a',
          marker: expect.objectContaining({ sessionId: SESSION })
        }),
        expect.objectContaining({
          state: 'pending',
          marker: expect.objectContaining({ sessionId: 'second' })
        })
      ])
    )
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

  it('reclaims an expired in-progress reservation on the next mutation', async () => {
    await capsule.record([marker()], NOW)
    await capsule.beginResume([SESSION], 'operation-a', NOW)
    const later = NOW + 10 * 60 * 1000 + 1

    // A read remains read-only, but the expired reservation is visible as a pending offer.
    expect(await capsule.list(later)).toEqual([marker()])
    const reserved = await capsule.beginResume([SESSION], 'operation-b', later)
    expect(reserved).toEqual([marker()])
    await capsule.completeResume('operation-b', [SESSION], later)
    expect(await capsule.list(later)).toEqual([])
  })

  it('dismisses pending and active recovery records', async () => {
    await capsule.record([marker(), marker({ sessionId: 'second' })], NOW)
    await capsule.beginResume([SESSION], 'operation-a', NOW)

    expect(await capsule.clearAll(NOW)).toBe(1)
    expect(await capsule.list(NOW)).toEqual([])

    // A later failed action cannot resurrect a record the user explicitly dismissed.
    await capsule.rollbackResume('operation-a', NOW)
    expect(await capsule.list(NOW)).toEqual([])
  })

  it('fences a late teardown write until a genuinely newer interruption', async () => {
    await capsule.record([marker()], NOW)
    await capsule.clearAll(NOW + 1)

    // This is the stale callback that can outlive a timed teardown phase in another host.
    await capsule.record([marker()], NOW + 1)
    expect(await capsule.list(NOW + 1)).toEqual([])

    const newer = marker({ recordedAt: NOW + 2, teardownId: 'teardown-new' })
    await capsule.record([newer], NOW + 2)
    expect(await capsule.list(NOW + 2)).toEqual([newer])

    // A new interruption must not remove the fence before the old callback has finished.
    await capsule.record([marker()], NOW + 2)
    expect(await capsule.list(NOW + 2)).toEqual([newer])
  })

  it('keeps a legacy v1 file readable until a mutating operation migrates it', async () => {
    const legacy = JSON.stringify({ version: 1, markers: [marker()] })
    await writeFile(filePath, legacy)

    expect(await capsule.list(NOW)).toEqual([marker()])
    expect(await readFile(filePath, 'utf8')).toBe(legacy)

    await capsule.record([marker({ sessionId: 'second' })], NOW)
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toMatchObject({ version: 2 })
    expect(await capsule.list(NOW)).toEqual([marker(), marker({ sessionId: 'second' })])
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

  it('lets explicit dismissal replace an unreadable file with an empty fence', async () => {
    await writeFile(filePath, '{')

    expect(await capsule.clearAll(NOW)).toBe(0)
    await expect(capsule.list(NOW)).resolves.toEqual([])
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toMatchObject({
      version: 2,
      entries: [],
      dismissedAt: NOW
    })
  })

  it('preserves prior records when a durable publication fails', async () => {
    await capsule.record([marker()], NOW)
    const publish = failPublish()

    await expect(capsule.record([marker({ sessionId: 'second' })], NOW)).rejects.toThrow(
      'publish unavailable'
    )
    publish.mockRestore()
    expect(await capsule.list(NOW)).toEqual([marker()])
  })

  it('preserves a pending offer when reservation publication fails', async () => {
    await capsule.record([marker()], NOW)
    const publish = failPublish()

    await expect(capsule.beginResume([SESSION], 'operation-a', NOW)).rejects.toThrow(
      'publish unavailable'
    )
    publish.mockRestore()
    expect(await capsule.list(NOW)).toEqual([marker()])
  })

  it('preserves an active reservation when completion publication fails', async () => {
    await capsule.record([marker()], NOW)
    await capsule.beginResume([SESSION], 'operation-a', NOW)
    const publish = failPublish()

    await expect(capsule.completeResume('operation-a', [SESSION], NOW)).rejects.toThrow(
      'publish unavailable'
    )
    publish.mockRestore()
    expect(await capsule.list(NOW)).toEqual([])

    await capsule.rollbackResume('operation-a', NOW)
    expect(await capsule.list(NOW)).toEqual([marker()])
  })

  // No TTL: an offer ends only by the user's own actions, however long the app was closed.
  it.each([NOW - 90 * 24 * 60 * 60 * 1000, NOW + 1])(
    'still lists a months-old or clock-skewed marker (%s)',
    async (recordedAt) => {
      await capsule.record([marker({ recordedAt })], recordedAt)
      expect(await capsule.list(NOW)).toHaveLength(1)
    }
  )

  it('reclaims stale durable-write debris without touching unrelated files', async () => {
    const abandoned = `${filePath}.0.1.abandoned.tmp`
    const recent = `${filePath}.0.2.recent.tmp`
    const unrelated = join(directory, 'conversation.tmp')
    await Promise.all([abandoned, recent, unrelated].map((path) => writeFile(path, 'debris')))
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000)
    await utimes(abandoned, old, old)

    await capsule.record([marker()], NOW)

    expect(await readdir(directory)).toEqual(
      expect.arrayContaining([
        AGENT_SESSION_RECOVERY_CAPSULE_FILE,
        `${AGENT_SESSION_RECOVERY_CAPSULE_FILE}.0.2.recent.tmp`,
        'conversation.tmp'
      ])
    )
    expect(await readdir(directory)).not.toContain(
      `${AGENT_SESSION_RECOVERY_CAPSULE_FILE}.0.1.abandoned.tmp`
    )
  })
})

it('does not retain lock timers after reads, writes, or failed publications', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  try {
    expect(vi.getTimerCount()).toBe(0)
    await capsule.record([marker()], NOW)
    expect(vi.getTimerCount()).toBe(0)
    await capsule.list(NOW)
    expect(vi.getTimerCount()).toBe(0)
    failPublish()
    await expect(capsule.record([marker()], NOW)).rejects.toThrow()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})
