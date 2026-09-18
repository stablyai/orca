import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_SESSION_RESUME_MARKER_TTL_MS } from '../../shared/agent-session-resume-marker'
import * as durable from '../durable-file-write'
import { withFileTransactionLock } from '../file-transaction-lock'
import {
  marker,
  NOW,
  record,
  SESSION
} from '../native-chat/agent-session-wire/structured-agent-session-restart-resume-test-harness'
import { AgentSessionRecordStore } from './agent-session-record-store'
import { agentSessionStorePath } from './agent-session-record-store-file'
import * as serialization from './agent-session-store-serialization'
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

async function seedConversationStore(
  legacyMarkers: unknown = {
    [SESSION]: { ...marker(), teardownId: undefined, launchId: 'legacy-launch' }
  }
) {
  const storeDirectory = join(directory, 'records')
  await mkdir(storeDirectory)
  const storePath = agentSessionStorePath(storeDirectory)
  const payload = JSON.stringify({
    schemaVersion: 2,
    hostId: 'local',
    records: { [SESSION]: record() },
    operations: {},
    retiredClaimKeys: [],
    unusableRecords: {},
    resumeMarkers: legacyMarkers
  })
  await writeFile(storePath, payload)
  await writeFile(`${storePath}.bak`, payload)
  return { storeDirectory, storePath, payload }
}

describe('non-backed-up recovery capsule', () => {
  it('publishes the complete set and gives it to only one successful take', async () => {
    const markers = [marker(), marker({ sessionId: 'second' })]
    await capsule.record(markers, NOW)
    expect(await new AgentSessionRecoveryCapsule(directory).take(NOW)).toEqual(markers)
    expect(await capsule.take(NOW)).toEqual([])
    expect(await readdir(directory)).toEqual([AGENT_SESSION_RECOVERY_CAPSULE_FILE])
  })

  it('replaces the previous witness set in one publication', async () => {
    await capsule.record([marker()], NOW)
    const replacement = marker({ sessionId: 'replacement', teardownId: 'teardown-b' })
    await capsule.record([replacement], NOW)
    expect(await capsule.take(NOW)).toEqual([replacement])
  })

  it('allows only one runtime to take across competing file-lock owners', async () => {
    await capsule.record([marker()], NOW)
    const results = await Promise.allSettled([
      capsule.take(NOW),
      new AgentSessionRecoveryCapsule(directory).take(NOW)
    ])
    const taken = results.flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
    expect(taken).toEqual([marker()])
    expect(await capsule.take(NOW)).toEqual([])
  })

  it('cannot resurrect consumed A after B fails publication and C succeeds', async () => {
    await capsule.record([marker({ teardownId: 'A' })], NOW)
    expect(await capsule.take(NOW)).toHaveLength(1)
    const publish = failPublish()
    await expect(capsule.record([marker({ teardownId: 'B' })], NOW)).rejects.toThrow(
      'publish unavailable'
    )
    publish.mockRestore()
    const third = new AgentSessionRecoveryCapsule(directory)
    expect(await third.take(NOW)).toEqual([])
    await third.record([marker({ teardownId: 'C' })], NOW)
    expect(await new AgentSessionRecoveryCapsule(directory).take(NOW)).toEqual([
      marker({ teardownId: 'C' })
    ])
  })

  it.each(['{', JSON.stringify({ version: 1, markers: [marker(), { sessionId: 5 }] })])(
    'refuses a corrupt capsule without exposing partial candidates: %s',
    async (raw) => {
      await writeFile(filePath, raw)
      await expect(capsule.take(NOW)).rejects.toThrow()
    }
  )

  it('refuses failed reads', async () => {
    await mkdir(filePath)
    await expect(capsule.take(NOW)).rejects.toThrow()
  })

  it('exposes nothing on failed clear and permits a later successful take of unclaimed work', async () => {
    await capsule.record([marker()], NOW)
    const publish = failPublish()
    await expect(capsule.take(NOW)).rejects.toThrow('publish unavailable')
    publish.mockRestore()
    expect(await new AgentSessionRecoveryCapsule(directory).take(NOW)).toEqual([marker()])
  })

  it.each([NOW - AGENT_SESSION_RESUME_MARKER_TTL_MS - 1, NOW + 1])(
    'consumes but refuses a witness outside its freshness window (%s)',
    async (recordedAt) => {
      await capsule.record([marker({ recordedAt })], recordedAt)
      expect(await capsule.take(NOW)).toEqual([])
      expect(await capsule.take(recordedAt)).toEqual([])
    }
  )

  it.each([false, true])(
    'ignores legacy markers without losing conversation data (backup: %s)',
    async (backup) => {
      const { storeDirectory, storePath } = await seedConversationStore()
      await capsule.record([marker()], NOW)
      expect(await capsule.take(NOW)).toHaveLength(1)
      if (backup) {
        await writeFile(storePath, '{')
      }
      const store = await AgentSessionRecordStore.open({
        directory: storeDirectory,
        hostId: 'local'
      })
      expect(store.getRecord(SESSION)?.sessionId).toBe(SESSION)
      expect(store.getRecord(SESSION)?.providerHandleChain).toEqual(record().providerHandleChain)
      expect(await new AgentSessionRecoveryCapsule(directory).take(NOW)).toEqual([])
      await store.setSessionTabVisibility(SESSION, true)
      expect(JSON.parse(await readFile(storePath, 'utf8')).resumeMarkers).toBeUndefined()
    }
  )

  it('keeps advisory I/O off session serialization, backups and the session transaction lock', async () => {
    const { storePath, payload } = await seedConversationStore()
    const records = Object.fromEntries(
      Array.from({ length: 2000 }, (_, index) => {
        const sessionId = `session-${index}`
        const entry = record()
        return [sessionId, { ...entry, sessionId, lease: { ...entry.lease, sessionId } }]
      })
    )
    const largePayload = JSON.stringify({ ...JSON.parse(payload), records })
    expect(Buffer.byteLength(largePayload)).toBeGreaterThan(1_000_000)
    await writeFile(storePath, largePayload)
    const serialize = vi.spyOn(serialization, 'serializeAgentSessionStoreState')
    const backup = vi.spyOn(durable, 'copyFileDurable')
    const writes = vi.spyOn(durable, 'writeTempFileDurable')
    await withFileTransactionLock(storePath, async () => {
      await capsule.record([marker()], NOW)
      expect(await capsule.take(NOW)).toEqual([marker()])
    })
    expect(serialize).not.toHaveBeenCalled()
    expect(backup).not.toHaveBeenCalled()
    expect(writes).toHaveBeenCalledTimes(2)
    expect(
      writes.mock.calls.reduce((bytes, call) => bytes + Buffer.byteLength(call[1]), 0)
    ).toBeLessThan(1024)
    expect(await readFile(storePath, 'utf8')).toBe(largePayload)
    expect(await readFile(`${storePath}.bak`, 'utf8')).toBe(payload)
  })
})

it('has no idle work or retained lock timers after publication, take, or failure', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  try {
    expect(vi.getTimerCount()).toBe(0)
    await capsule.record([marker()], NOW)
    expect(vi.getTimerCount()).toBe(0)
    await capsule.take(NOW)
    expect(vi.getTimerCount()).toBe(0)
    failPublish()
    await expect(capsule.record([marker()], NOW)).rejects.toThrow()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

it('reclaims expired publication debris without touching recent or unrelated files', async () => {
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
