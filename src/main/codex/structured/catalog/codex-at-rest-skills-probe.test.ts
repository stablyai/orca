import * as Files from 'node:fs/promises'
import { scanClaudeCommandFolders } from '../../../claude/claude-command-folder-scan'
import * as Catalog from '../../../native-chat/agent-session-wire/options/at-rest-command-catalog'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { agentSessionRecordFixture } from '../../../native-chat/agent-session-record-test-fixture'
import type { CodexAppServerInvocation } from '../../app-server/codex-app-server-session'
import { createCodexAtRestSkillCatalog } from './codex-at-rest-skills-probe'

const folders = vi.hoisted(() => ({ open: vi.fn(), read: vi.fn() }))
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof Files>()),
  opendir: folders.open,
  readFile: folders.read,
  stat: vi.fn(async () => ({ isDirectory: () => true }))
}))
afterEach(() => vi.useRealTimers())

function floatingCodexChat(sessionId: string, launchDirectory: string) {
  return agentSessionRecordFixture({
    sessionId,
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: '/home/me/.codex' },
    launchDirectory,
    location: { workspaceId: FLOATING_TERMINAL_WORKTREE_ID }
  })
}

const visits = vi.hoisted(() => vi.fn((current: boolean) => current))
vi.mock(
  '../../../native-chat/agent-session-wire/options/at-rest-command-catalog',
  async (original) => {
    const actual = await original<typeof Catalog>()
    return {
      ...actual,
      AtRestCommandCatalog: vi.fn(function (source: Catalog.AtRestCommandSource) {
        return new actual.AtRestCommandCatalog({
          ...source,
          scan: (record, cwd, current, ...rest) =>
            source.scan(record, cwd, () => visits(current()), ...rest)
        })
      })
    }
  }
)
const listingRpc = {
  request: async (_method: string, params: Record<string, unknown> = {}) => ({
    data: (Array.isArray(params.cwds) ? params.cwds.map(String) : [])
      .map((cwd) => {
        const name = `${cwd.split('/').at(-1)}-skill`
        return { cwd, skills: [{ name, path: `${cwd}/${name}/SKILL.md` }] }
      })
      .toReversed()
  }),
  notify: () => {}
}

it('closes a directory opened after cancellation before any read or recursion', async () => {
  const opened = Promise.withResolvers<unknown>()
  const next = vi.fn(() => new Promise<IteratorResult<never>>(() => {}))
  const close = vi.fn(async () => undefined)
  folders.open.mockReturnValueOnce(opened.promise)
  const stop = new AbortController()
  const reading = scanClaudeCommandFolders(['/commands'], stop.signal)
  const rejected = expect(reading).rejects.toThrow('cancelled')
  stop.abort(new Error('cancelled'))
  opened.resolve({ close, [Symbol.asyncIterator]: () => ({ next }) })
  await rejected
  expect(close).toHaveBeenCalledExactlyOnceWith()
  expect(next).not.toHaveBeenCalled()
  expect(folders.open).toHaveBeenCalledExactlyOnceWith('/commands')
  expect(folders.read).not.toHaveBeenCalled()
})

describe('a resting Codex chat lists the skills Codex would load', () => {
  it('answers every pinned folder from one probe before it settles, which then ends the whole tree', async () => {
    const invocations: CodexAppServerInvocation[] = []
    const settling: (() => void)[] = []
    let prefixArgs = ['run', '--', 'codex']
    const catalog = createCodexAtRestSkillCatalog({
      resolveWorkspacePath: async () => '/unused',
      resolveLaunchArgs: () => [
        '--disable',
        'plugins',
        '-c',
        'features.test=true',
        '--sandbox',
        'read-only'
      ],
      resolveEnvironment: async () => ({ PATH: '/bin', CUSTOM_AGENT_ENV: 'configured' }),
      resolveCommand: () => ({ command: '/bin/launcher', prefixArgs }),
      sleep: () => new Promise((resolve) => settling.push(resolve)),
      runSession: async (invocation, body) => {
        invocations.push(invocation)
        return body(listingRpc)
      }
    })
    const one = floatingCodexChat('one', '/work/one')
    const two = floatingCodexChat('two', '/work/two')

    expect(catalog.read(one)).toBeUndefined()
    expect(catalog.read(two)).toBeUndefined()
    await Promise.all([catalog.settled(one, 1_000), catalog.settled(two, 1_000)])

    expect(catalog.read(one)?.filter((row) => row.kind === 'skill')).toEqual([
      { name: 'one-skill', kind: 'skill', path: '/work/one/one-skill/SKILL.md' }
    ])
    expect(catalog.read(two)?.filter((row) => row.kind === 'skill')).toEqual([
      { name: 'two-skill', kind: 'skill', path: '/work/two/two-skill/SKILL.md' }
    ])
    expect(invocations.map((invocation) => invocation.args)).toEqual([
      ['run', '--', 'codex', '--disable', 'plugins', '-c', 'features.test=true', 'app-server']
    ])
    // A settling probe must not hold the folder open, or Windows cannot remove the worktree.
    expect(invocations[0]?.cwd?.startsWith('/work')).toBe(false)
    expect(invocations[0]?.treeKillOnFinish).toBe(true)
    expect(invocations[0]?.env).toMatchObject({
      CODEX_HOME: '/home/me/.codex',
      CUSTOM_AGENT_ENV: 'configured'
    })
    expect(invocations[0]?.envToDelete).toEqual(['ORCA_CHAT_SCRATCH_DIR', 'ORCA_CHAT_VISUALS_DIR'])
    expect(settling).toHaveLength(1)
    prefixArgs = ['run', '--profile', 'other', '--', 'codex']
    catalog.retireContext()
    await catalog.settled(one, 1_000)
    expect(catalog.read(one)?.some((row) => row.name === 'one-skill')).toBe(true)
    expect(invocations).toHaveLength(2)
    expect(invocations[1]?.args).toEqual([
      ...prefixArgs,
      '--disable',
      'plugins',
      '-c',
      'features.test=true',
      'app-server'
    ])
    settling.forEach((resolve) => resolve())
    catalog.dispose()
  })

  it.each(['method not found', 'temporary failure'])(
    'retains the floor after %s without holding the answer',
    async (message) => {
      const floor = Promise.withResolvers<void>()
      let closed = false
      const sleep = vi.fn(() => floor.promise)
      const catalog = createCodexAtRestSkillCatalog({
        resolveWorkspacePath: async () => '/work',
        resolveLaunchArgs: () => [],
        resolveCommand: () => ({ command: '/bin/codex', prefixArgs: [] }),
        now: () => 0,
        sleep,
        runSession: async (_invocation, body) => {
          try {
            return await body({
              request: async () => {
                throw new Error(message)
              },
              notify: () => {}
            })
          } finally {
            closed = true
          }
        }
      })
      const record = floatingCodexChat('failed', '/work')
      catalog.read(record)
      await catalog.settled(record, 1_000)
      expect(sleep).toHaveBeenCalledWith(70_000)
      expect(closed).toBe(false)
      floor.resolve()
      await vi.waitFor(() => expect(closed).toBe(true))
    }
  )
  it('caps per-key failures, ages success from admission, skips missing cwd and evicts unread entries', async () => {
    vi.useFakeTimers()
    const completion = Promise.withResolvers<void>()
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const scan = vi.fn<Catalog.AtRestCommandSource['scan']>(async (...args) => {
      if (scan.mock.calls.length <= 3) {
        throw new Error('source failed')
      }
      args[5]()
      await (scan.mock.calls.length === 4 ? completion.promise : undefined)
      return { commands: [], fromAgent: true }
    })
    const catalog = new Catalog.AtRestCommandCatalog({
      accepts: () => true,
      resolveWorkspacePath: async () => '/work',
      label: 'fixture',
      scan
    })
    const chat = floatingCodexChat('one', '/work/one')
    for (const [attempt, ms] of [0, 10_000, 10_000, 299_999].entries()) {
      await vi.advanceTimersByTimeAsync(ms)
      catalog.read(chat)
      await vi.advanceTimersByTimeAsync(0)
      expect(scan).toHaveBeenCalledTimes(Math.min(attempt + 1, 3))
    }
    await vi.advanceTimersByTimeAsync(1)
    catalog.read(chat)
    await vi.advanceTimersByTimeAsync(105_000)
    completion.resolve()
    await catalog.settled(chat, 1_000)
    expect(catalog.read(chat)).toEqual([])
    await vi.advanceTimersByTimeAsync(195_000)
    await catalog.settled(chat, 1_000)
    expect(scan).toHaveBeenCalledTimes(5)
    catalog.retireContext()
    vi.mocked(Files.stat).mockRejectedValueOnce({ code: 'ENOENT' })
    expect(await catalog.settled(chat, 1_000)).toBeUndefined()
    expect(scan).toHaveBeenCalledTimes(5)
    const removed = vi.spyOn(Map.prototype, 'delete')
    await vi.advanceTimersByTimeAsync(3_600_000)
    await catalog.settled(floatingCodexChat('two', '/work/two'), 1_000)
    expect(removed.mock.calls.flat().join()).toContain('/work/one')
    removed.mockRestore()
    catalog.dispose()
    warned.mockRestore()
  })
})
