import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { AgentSessionResumeMarker } from '../../../../shared/agent-session/lifecycle/resume/agent-session-resume-marker'
import {
  marker,
  NOW
} from '../../../native-chat/agent-session-wire/recovery/testing/structured-agent-session-restart-resume.test-fixture'
import { AgentSessionRecoveryCapsule } from './agent-session-recovery-capsule'

const MINUTE = 60_000
let directory: string
let capsule: AgentSessionRecoveryCapsule

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-recovery-automatic-'))
  capsule = new AgentSessionRecoveryCapsule(directory)
})

afterEach(async () => {
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

it('leaves a cut that was asking its person to that person', async () => {
  const asking = {
    activity: {
      state: 'blocked' as const,
      prompts: [{ kind: 'approval' as const, label: 'Run it?' }],
      tasks: []
    }
  }
  expect(await launch('turn-1', NOW, asking)).toBe(0)
  expect(await capsule.beginResume(undefined, 'person', NOW)).toHaveLength(1)
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
