import * as Files from 'node:fs/promises'
import { scanClaudeCommandFolders } from '../claude/claude-command-folder-scan'
import * as Catalog from '../native-chat/agent-session-wire/at-rest-command-catalog'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import { agentSessionRecordFixture } from '../native-chat/agent-session-record-test-fixture'
import type { CodexAppServerInvocation } from './codex-app-server-session'
import type { CodexAtRestSkillsDeps } from './codex-at-rest-skills-probe'
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
vi.mock('../native-chat/agent-session-wire/at-rest-command-catalog', async (original) => {
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
})
function harness(deps: Partial<CodexAtRestSkillsDeps> = {}) {
  const initialized = Promise.withResolvers<void>(),
    closed = Promise.withResolvers<void>()
  let live = 0,
    peak = 0
  const calls: CodexAppServerInvocation[] = []
  const request = vi.fn(listingRpc.request)
  const catalog = createCodexAtRestSkillCatalog({
    resolveWorkspacePath: async () => '/work/one',
    resolveLaunchArgs: () => [],
    resolveCommand: () => ({ command: '/bin/codex', prefixArgs: [] }),
    runSession: async (invocation, body) => {
      calls.push(invocation)
      peak = Math.max(peak, ++live)
      try {
        await initialized.promise
        return await body({ request, notify: () => {} })
      } finally {
        await closed.promise
        live--
      }
    },
    ...deps
  })
  return { catalog, calls, request, initialized, closed, peak: () => peak }
}
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
  it.each([16, 160])(
    'keeps %i queued folders linear through cancellation and teardown',
    async (count) => {
      vi.useFakeTimers()
      visits.mockClear()
      let canonical = true,
        mirrored = true
      const h = harness({
          prepareHome: () => {
            mirrored = canonical
          }
        }),
        removed = vi.spyOn(Set.prototype, 'delete')
      const chats = Array.from({ length: count }, (_, i) =>
        floatingCodexChat(String(i), `/work/w${i}`)
      )
      chats.forEach(h.catalog.read)
      await vi.advanceTimersByTimeAsync(0)
      canonical = false
      h.catalog.retireContext()
      chats.forEach(h.catalog.read)
      h.request.mockImplementation(async (_method, params = {}) => ({
        data: (Array.isArray(params.cwds) ? params.cwds.map(String) : []).map((cwd) => ({
          cwd,
          skills: mirrored ? [{ name: 'plugin', path: '/plugin/SKILL.md' }] : []
        }))
      }))
      const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      h.initialized.resolve()
      await vi.advanceTimersByTimeAsync(0)
      expect(h.calls).toHaveLength(1)
      expect(h.request).toHaveBeenCalledTimes(count / 8)
      expect(visits.mock.calls.length).toBeLessThan(8 * count)
      // Pool requests and removable answer waiters each have a linear work budget.
      const values = removed.mock.calls.map(([value]) => value)
      expect(
        values.filter((value) => value && typeof value === 'object' && 'cwd' in value)
      ).toHaveLength(4 * count)
      expect(
        values.filter((value) => value && typeof value === 'object' && 'ready' in value)
      ).toHaveLength(16 * count)
      removed.mockRestore()
      expect(chats.map(h.catalog.read).every(Boolean)).toBe(true)
      h.catalog.retireContext()
      h.request.mockRejectedValueOnce(new Error('reload failed'))
      h.catalog.read(chats[0])
      await vi.advanceTimersByTimeAsync(10_000)
      await h.catalog.settled(chats[0], 1_000)
      expect(h.request.mock.calls[0][1]?.forceReload).toBe(true)
      expect(h.request.mock.lastCall?.[1]?.forceReload).toBe(true)
      expect(h.catalog.read(chats[0])?.filter((row) => row.kind === 'skill')).toEqual([])
      h.catalog.retireContext()
      await vi.advanceTimersByTimeAsync(59_999)
      expect(h.calls[0].signal?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      const identities = chats.map((chat, i) => ({
        ...chat,
        accountHome: { ...chat.accountHome, path: String(i) }
      }))
      identities.slice(0, 2).forEach(h.catalog.read)
      await vi.advanceTimersByTimeAsync(0)
      expect(h.calls).toHaveLength(2)
      expect(h.peak()).toBe(2)
      h.closed.resolve()
      await vi.advanceTimersByTimeAsync(0)
      expect(h.calls).toHaveLength(3)
      expect(h.peak()).toBe(2)
      h.catalog.dispose()
      await vi.advanceTimersByTimeAsync(0)
      expect(vi.getTimerCount()).toBe(0)
      const failed = harness()
      failed.closed.resolve()
      failed.initialized.reject(new Error('initialize failed'))
      identities.forEach(failed.catalog.read)
      await vi.advanceTimersByTimeAsync(0)
      expect(failed.calls).toHaveLength(count)
      for (const seconds of [10, 30, 90, 300]) {
        const before = failed.calls.length
        failed.catalog.retireContext()
        failed.catalog.read(identities[0])
        await vi.advanceTimersByTimeAsync(0)
        expect(failed.calls).toHaveLength(before)
        await vi.advanceTimersByTimeAsync(seconds * 1_000)
        failed.catalog.retireContext()
        await failed.catalog.settled(identities[0], 1_000)
        expect(failed.calls).toHaveLength(before + 1)
      }
      await vi.advanceTimersByTimeAsync(3_170_000)
      expect(vi.getTimerCount()).toBe(1)
      await vi.advanceTimersByTimeAsync(430_000)
      expect(vi.getTimerCount()).toBe(0)
      failed.catalog.dispose()
      warned.mockRestore()
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
