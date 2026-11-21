import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionResumeMarker } from '../../../../shared/agent-session/lifecycle/resume/agent-session-resume-marker'
import {
  marker,
  NOW
} from '../../../native-chat/agent-session-wire/recovery/testing/structured-agent-session-restart-resume.test-fixture'
import { AgentSessionRecoveryCapsule } from './agent-session-recovery-capsule'
import * as automaticLedger from './agent-session-recovery-automatic-ledger'

const MINUTE = 60_000
let directory: string
let capsule: AgentSessionRecoveryCapsule

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-recovery-automatic-'))
  capsule = new AgentSessionRecoveryCapsule(directory)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(directory, { recursive: true, force: true })
})

/** One launch: the run before it cut `turn`; Orca tries to continue it on its own. */
async function launch(turn: string, at: number, overrides: Partial<AgentSessionResumeMarker> = {}) {
  await capsule.record(
    [
      marker({
        work: { kind: 'turn', id: turn },
        teardownId: `crash:${at}`,
        recordedAt: at,
        ...overrides
      })
    ],
    at
  )
  const reserved = await capsule.beginResume(undefined, `operation-${at}`, at, true)
  await capsule.completeResume(
    `operation-${at}`,
    reserved.map((offer) => offer.sessionId),
    at
  )
  await capsule.passOverAutomatic(at, at)
  return reserved.length
}

it('continues each cut once, and at most three in five minutes', async () => {
  expect(await launch('turn-1', NOW)).toBe(1)
  // The same cut again: its continuation died before the agent took it.
  expect(await launch('turn-1', NOW + MINUTE)).toBe(0)
  expect(await launch('turn-2', NOW + 2 * MINUTE)).toBe(1)
  expect(await launch('turn-3', NOW + 3 * MINUTE)).toBe(1)
  expect(await launch('turn-4', NOW + 4 * MINUTE)).toBe(0)
  expect(await launch('turn-5', NOW + 7 * MINUTE)).toBe(1)
})

it('leaves a crash cut whose agent was not proven to have exited to the person', async () => {
  expect(await launch('turn-1', NOW, { trigger: 'crash', exitUnproven: true })).toBe(0)
  expect(await capsule.beginResume(undefined, 'person', NOW)).toHaveLength(1)
})

it('continues on its own only what the run that just ended cut', async () => {
  await capsule.record([marker({ teardownId: 'quit-earlier', recordedAt: NOW })], NOW)
  // A launch with the setting off passed over it.
  await capsule.passOverAutomatic(NOW, NOW)
  expect(await capsule.beginResume(undefined, 'automatic', NOW + MINUTE, true)).toEqual([])
  expect(await capsule.beginResume(undefined, 'person', NOW + MINUTE)).toHaveLength(1)
})

it('leaves an offer a quit records during the automatic turn to the next launch', async () => {
  await capsule.record([marker({ teardownId: 'quit-during', recordedAt: NOW + 1 })], NOW + 1)
  await capsule.passOverAutomatic(NOW, NOW + 2)
  expect(await capsule.beginResume(undefined, 'next launch', NOW + MINUTE, true)).toHaveLength(1)
})

it('keeps a dismissed crash cut dismissed when a later launch reads it again, and offers a new cut', async () => {
  const cut = (turn: string, at: number) =>
    marker({ work: { kind: 'turn', id: turn }, teardownId: 'crash:runtime-1', recordedAt: at })
  await capsule.record([cut('turn-1', NOW)], NOW)
  await capsule.dismiss([cut('turn-1', NOW).sessionId], NOW + MINUTE)
  // The chat is still held by the crashed run, so the next launch derives the same offer.
  await capsule.record([cut('turn-1', NOW)], NOW + 2 * MINUTE)
  expect(await capsule.list(NOW + 2 * MINUTE)).toEqual([])
  await capsule.record([cut('turn-2', NOW + 3 * MINUTE)], NOW + 3 * MINUTE)
  expect(await capsule.list(NOW + 3 * MINUTE)).toHaveLength(1)
})

it('takes nothing on its own while the ledger of what it took cannot be read', async () => {
  await capsule.record([marker({ recordedAt: NOW })], NOW)
  await writeFile(join(directory, 'agent-session-recovery-automatic.json'), '{not json')
  expect(await capsule.beginResume(undefined, 'automatic', NOW, true)).toEqual([])
  // Neither a pass-over nor a dismissal replaces it with an empty one.
  await capsule.passOverAutomatic(NOW, NOW)
  await capsule.record([marker({ sessionId: 'second', recordedAt: NOW })], NOW)
  await capsule.dismiss(['second'], NOW)
  await capsule.record([marker({ sessionId: 'third', recordedAt: NOW + MINUTE })], NOW + MINUTE)
  expect(await capsule.beginResume(undefined, 'next launch', NOW + MINUTE, true)).toEqual([])
  expect(await capsule.beginResume(undefined, 'person', NOW + MINUTE)).toHaveLength(2)
})

it('undoes an automatic reservation it could not record', async () => {
  await capsule.record([marker({ recordedAt: NOW })], NOW)
  vi.spyOn(automaticLedger, 'writeAutomaticRestartLedger').mockRejectedValueOnce(
    new Error('disk full')
  )
  await expect(capsule.beginResume(undefined, 'automatic', NOW, true)).rejects.toThrow('disk full')
  expect(await capsule.list(NOW)).toHaveLength(1)
})

it('keeps an offer passed over while a person holds it, should their continuation be undone', async () => {
  await capsule.record([marker({ teardownId: 'quit-earlier', recordedAt: NOW })], NOW)
  await capsule.passOverAutomatic(NOW, NOW)
  await capsule.beginResume(undefined, 'person', NOW + 1)
  await capsule.passOverAutomatic(NOW + 2, NOW + 2)
  await capsule.rollbackResume('person', NOW + 3)
  expect(await capsule.beginResume(undefined, 'automatic', NOW + MINUTE, true)).toEqual([])
})

it('writes a ledger its own reader accepts even with maximum-length offer ids', async () => {
  const entries = Array.from({ length: 1000 }, (_, index) => ({
    state: 'pending' as const,
    marker: marker({
      sessionId: `${index}`.padEnd(512, 's'),
      teardownId: 't'.repeat(512),
      recordedAt: 1
    })
  }))
  const next = automaticLedger.passOverAutomaticOffers(
    { taken: {}, passed: [], dismissed: [] },
    entries,
    10
  )

  await automaticLedger.writeAutomaticRestartLedger(join(directory, 'capsule.json'), next)

  expect(
    await automaticLedger.readAutomaticReservationLedger(join(directory, 'capsule.json'))
  ).not.toBeNull()
})

it('sheds old continuation records before passed-over offers when the ledger is too large', async () => {
  const taken = Object.fromEntries(
    Array.from({ length: 1500 }, (_, index) => [
      `${index}`.padEnd(512, 's'),
      [{ at: index * 10 * 60_000, work: `turn:${'w'.repeat(500)}` }]
    ])
  )
  const path = join(directory, 'capsule.json')

  await automaticLedger.writeAutomaticRestartLedger(path, {
    taken,
    passed: ['session-a:td:1'],
    dismissed: []
  })

  const read = await automaticLedger.readAutomaticReservationLedger(path)
  expect(read?.passed).toEqual(['session-a:td:1'])
})

it('keeps a recent continuation when passed-over offers force the ledger to shrink', async () => {
  const path = join(directory, 'capsule.json')
  const passed = Array.from({ length: 1000 }, (_, index) => `${index}`.padEnd(512, 's'))

  await automaticLedger.writeAutomaticRestartLedger(path, {
    taken: { 'session-a': [{ at: 10, work: 'turn:t1' }] },
    passed,
    dismissed: []
  })

  const read = await automaticLedger.readAutomaticReservationLedger(path)
  expect(read?.taken['session-a']).toEqual([{ at: 10, work: 'turn:t1' }])
})

it('keeps in-window continuations that fit within the read limit', async () => {
  const path = join(directory, 'capsule.json')
  const taken = Object.fromEntries(
    Array.from({ length: 260 }, (_, index) => [
      `${index}`.padEnd(512, 's'),
      [1, 2, 3].map((at) => ({ at, work: `turn:${'w'.repeat(500)}` }))
    ])
  )

  await automaticLedger.writeAutomaticRestartLedger(path, { taken, passed: [], dismissed: [] })

  const read = await automaticLedger.readAutomaticReservationLedger(path)
  expect(Object.values(read?.taken ?? {}).flat()).toHaveLength(780)
})
