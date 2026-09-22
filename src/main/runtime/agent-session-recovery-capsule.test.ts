import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_SESSION_RESUME_MARKER_TTL_MS } from '../../shared/agent-session-resume-marker'
import * as durable from '../durable-file-write'
import {
  marker,
  NOW,
  SESSION
} from '../native-chat/agent-session-wire/structured-agent-session-restart-resume-test-harness'
import {
  AgentSessionRecoveryCapsule,
  AGENT_SESSION_RECOVERY_CAPSULE_FILE
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

  it.each([NOW - AGENT_SESSION_RESUME_MARKER_TTL_MS - 1, NOW + 1])(
    'does not list an expired or future marker (%s)',
    async (recordedAt) => {
      await capsule.record([marker({ recordedAt })], recordedAt)
      expect(await capsule.list(NOW)).toEqual([])
    }
  )

  it('reclaims stale durable-write debris without touching unrelated files', async () => {
    const abandoned = `${filePath}.0.1.abandoned.tmp`
    const recent = `${filePath}.0.2.recent.tmp`
    const unrelated = join(directory, 'conversation.tmp')
    await Promise.all([abandoned, recent, unrelated].map((path) => writeFile(path, 'debris')))
    const old = new Date(Date.now() - AGENT_SESSION_RESUME_MARKER_TTL_MS - 1000)
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
