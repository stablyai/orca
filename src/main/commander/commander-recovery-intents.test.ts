import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { recoveryEntry } from './commander-recovery-entry'
import { RecoveryIntents } from './commander-recovery-intents'
import type { RecoveryRecord } from './commander-recovery-observation'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

it('replays only the staged turn of this consent generation after restart and preserves a newer turn during acknowledgment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-recovery-intents-'))
  dirs.push(root)
  const dir = join(root, 'org-one', 'generation-one')
  const a = new RecoveryIntents(dir)
  const record = {
    provider: 'codex',
    sessionId: 'session-one',
    location: {
      executionHostId: 'local',
      workspaceKind: 'git-worktree',
      wslDistro: null,
      workspaceId: 'worktree:repo::/local/repo'
    },
    lastTurn: {
      at: 123,
      state: 'open',
      prompt: 'Continue the build',
      reply: 'old response outside current turn'
    }
  } satisfies RecoveryRecord
  const withPrivateData = { ...record, providerHandleChain: ['private native session'] }
  await a.stage(withPrivateData)
  await a.stop()
  const names = await readdir(join(dir, 'intents'))
  const json = await readFile(join(dir, 'intents', names[0]!), 'utf8')
  expect(json).not.toContain('private native session')
  expect(json).not.toContain('old response outside current turn')
  const b = new RecoveryIntents(dir)
  const staged = await b.next()
  expect(staged?.lastTurn?.prompt).toBe('Continue the build')
  expect(await new RecoveryIntents(join(root, 'org-two', 'generation-one')).next()).toBeNull()
  expect(await new RecoveryIntents(join(root, 'org-one', 'generation-two')).next()).toBeNull()

  const settled = {
    ...record,
    lastTurn: { ...record.lastTurn, state: 'settled' as const, reply: 'Build succeeded' }
  }
  await b.stage(settled)
  if (!staged) {
    throw new Error('Expected durable turn')
  }
  await b.ack(staged)
  expect((await b.next())?.lastTurn?.reply).toBe('Build succeeded')
  await b.ack(settled)
  expect(await b.next()).toBeNull()
})

it('carries the first goal through multiple pending turns and a restart before any Git enrichment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-recovery-intents-'))
  dirs.push(root)
  const spool = new RecoveryIntents(root)
  const record = {
    sessionId: 's',
    provider: 'codex',
    location: {
      executionHostId: 'local',
      workspaceKind: 'git-worktree',
      workspaceId: 'repo::path',
      wslDistro: null
    },
    lastTurn: { state: 'open', at: 1, prompt: 'Fix the checkout' }
  } satisfies RecoveryRecord
  await spool.stage(record)
  await spool.stage({ ...record, lastTurn: { ...record.lastTurn, at: 2, prompt: 'Run tests' } })
  await spool.stage({ ...record, lastTurn: { ...record.lastTurn, at: 3, prompt: 'continue' } })
  await spool.stop()
  const restarted = new RecoveryIntents(root)
  const pending = await restarted.next()
  if (!pending) {
    throw new Error('Expected pending turn')
  }
  const page = recoveryEntry(
    {
      sessionId: 's',
      provider: 'codex',
      projectId: 'repo',
      state: 'open',
      at: 3,
      branch: null,
      dirty: null,
      head: null,
      goal: pending.lastTurn.prompt,
      progress: 'Working',
      nextStep: 'Verify the checkout'
    },
    'generation',
    pending.initialGoal
  )
  expect(page.title).toBe('Fix the checkout')
  expect(page.body).toContain('Latest request: continue')
  await restarted.ack(pending)
  expect(await restarted.next()).toBeNull()
})
