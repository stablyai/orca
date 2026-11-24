import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
import type { RecoveryRecord } from './commander-recovery-observation'
import { CommanderRecoveryRecorder } from './commander-recovery-recorder'
import { publishRecoveryMemory } from './commander-memory-service'

const auth = vi.hoisted(() => ({ ticket: 'active' }))
vi.mock('./commander-recovery-account', () => ({
  epoch: () => auth.ticket,
  readConsent: async () => 'enabled'
}))
vi.mock('./commander-memory-service', () => ({ publishRecoveryMemory: vi.fn() }))

it('excludes inherited turns, then fences queued network work when the original account changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'commander-recorder-'))
  const store = {
    getRepo: () => ({ id: 'repo', path: '/tmp/source', upstream: { owner: 'team', repo: 'app' } })
  }
  const runtime = {
    requireStore: () => store,
    showManagedWorktree: async () => {
      throw new Error('worktree no longer available')
    }
  }
  const owner = {
    directory,
    ticket: 'active',
    account: { profileId: 'p', userId: 'alice', activeOrgId: 'org' }
  }
  let beforeRequest: (() => Promise<void>) | undefined
  const wait = Promise.withResolvers<void>()
  vi.mocked(publishRecoveryMemory).mockImplementation(async (_account, _page, guard) => {
    beforeRequest = guard
    await wait.promise
    await guard()
    return 'synced'
  })
  const recorder = new CommanderRecoveryRecorder(runtime, owner, 'enabled')
  try {
    const source: RecoveryRecord = {
      sessionId: 'session',
      provider: 'claude',
      location: {
        workspaceId: 'repo::/tmp/source',
        executionHostId: 'local',
        workspaceKind: 'git-worktree',
        wslDistro: null
      },
      lastTurn: { state: 'open', at: recorder.started - 1, prompt: 'Private earlier work' }
    }
    recorder.baseline([source])
    recorder.observe('session', {
      ...source,
      lastTurn: {
        state: 'settled',
        at: recorder.started + 1,
        prompt: 'Private earlier work',
        reply: 'sensitive'
      }
    })
    recorder.observe('session', {
      ...source,
      lastTurn: { state: 'open', at: recorder.started + 2, prompt: 'New goal' }
    })
    await vi.waitFor(() => expect(beforeRequest).toBeDefined())
    expect(vi.mocked(publishRecoveryMemory).mock.calls.map((call) => call[1].title)).toEqual([
      'New goal'
    ])
    auth.ticket = 'changed'
    await expect(beforeRequest?.()).rejects.toThrow('authorization changed')
  } finally {
    wait.resolve()
    await recorder.stop()
    await rm(directory, { force: true, recursive: true })
    auth.ticket = 'active'
  }
})
