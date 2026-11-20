import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCA_AGENT_SESSION_ID_ENV } from '../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import { REPEATED_FLAG_SEPARATOR } from '../arguments/args'
import type { RuntimeClient } from '../runtime/client'
import { BOT_CREATE_HANDLERS } from './bot-create'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

const ROWS = [
  { worktreeId: 'w1', displayName: 'release-checklist', agents: [], parentWorktreeId: null },
  { worktreeId: 'w2', displayName: 'changelog-1-5', agents: [], parentWorktreeId: null }
]

async function offer(flags: [string, string | boolean][]) {
  vi.stubEnv(ORCA_AGENT_SESSION_ID_ENV, 'chat-1')
  const calls: { method: string; params: unknown }[] = []
  const call = vi.fn(async (method: string, params?: unknown) => {
    calls.push({ method, params })
    const result =
      method === 'worktree.ps'
        ? { worktrees: ROWS, totalCount: ROWS.length, truncated: false }
        : method === 'bots.list'
          ? { bots: [] }
          : { offered: true, message: 'shown' }
    return { id: 'r', ok: true as const, result, _meta: { runtimeId: 'rt' } }
  })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only client.call.
  const client = { call } as unknown as RuntimeClient
  await BOT_CREATE_HANDLERS['bot create']!({
    flags: new Map<string, string | boolean>([['offer', true], ...flags]),
    client,
    cwd: '/',
    json: false
  })
  return calls.filter((entry) => entry.method === 'bots.createOffer')
}

describe('orca bot create --offer', () => {
  it('proposes the bot as a card, filling what the template says and naming each workspace', async () => {
    const calls = await offer([
      ['name', 'Cutter'],
      ['purpose', 'Tracks what’s blocking the 1.5 release.'],
      ['template', 'release'],
      ['worktree', ['name:release-checklist', 'id:w2'].join(REPEATED_FLAG_SEPARATOR)]
    ])
    expect(calls).toEqual([
      {
        method: 'bots.createOffer',
        params: {
          callerSessionId: 'chat-1',
          name: 'Cutter',
          purpose: 'Tracks what’s blocking the 1.5 release.',
          watches: 'Pull requests, checks and workspaces',
          does: 'Keeps a short readiness list: failing checks, pull requests waiting for review, open blockers.',
          reports: 'Here, weekday mornings',
          templateId: 'release',
          worktrees: [
            { id: 'w1', name: 'release-checklist' },
            { id: 'w2', name: 'changelog-1-5' }
          ]
        }
      }
    ])
  })

  it('never creates a bot directly: without --offer it refuses and calls nothing', async () => {
    const calls: string[] = []
    vi.stubEnv(ORCA_AGENT_SESSION_ID_ENV, 'chat-1')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only client.call.
    const client = {
      call: vi.fn(async (method: string) => {
        calls.push(method)
        return { id: 'r', ok: true as const, result: {}, _meta: { runtimeId: 'rt' } }
      })
    } as unknown as RuntimeClient
    await expect(
      BOT_CREATE_HANDLERS['bot create']!({
        flags: new Map([
          ['name', 'Cutter'],
          ['purpose', 'Track release']
        ]),
        client,
        cwd: '/',
        json: false
      })
    ).rejects.toThrow('A bot can’t create a bot. Propose one with --offer')
    expect(calls).toEqual([])
  })

  it('refuses a template Orca does not have', async () => {
    await expect(
      offer([
        ['name', 'Cutter'],
        ['purpose', 'x'],
        ['template', 'shipping']
      ])
    ).rejects.toThrow('--template is one of: pr-review, bug-investigation,')
  })
})
