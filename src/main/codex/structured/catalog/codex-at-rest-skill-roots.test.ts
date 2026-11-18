import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import { agentSessionRecordFixture } from '../../../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import { CodexAppServerUnsupportedError } from '../../app-server/codex-app-server-session'
import {
  createCodexAtRestSkillCatalog,
  type CodexAtRestSkillsDeps
} from './codex-at-rest-skills-probe'

type Probe = { roots: string[] | null; calls: string[] }

let base: string
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'codex-at-rest-roots-'))
})
afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

/** A resting chat in its own folder; `bot-a` and the like link projects, `plain` doesn't. */
function chat(name: string): AgentSessionRecord {
  return {
    ...agentSessionRecordFixture(),
    sessionId: `chat-${name}`,
    provider: 'codex',
    providerHandleChain: [],
    accountHome: { variable: 'CODEX_HOME', path: '/homes/codex' },
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: name,
      workspaceKind: 'folder'
    }
  }
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []

/** Fake Codex app-servers: each lists one skill per root it was given, and settles on demand. */
function codexHost(
  options: {
    setRoots?: (roots: string[]) => Promise<void>
    list?: (roots: string[] | null) => Promise<void>
    linked?: (workspaceId: string) => boolean
  } = {}
): {
  deps: CodexAtRestSkillsDeps
  probes: Probe[]
  peak: () => number
  /** Ends the oldest waiting settle grace, or every one. */
  settle: (all?: 'all') => void
} {
  const probes: Probe[] = []
  let live = 0
  let peak = 0
  const settles: (() => void)[] = []
  const deps: CodexAtRestSkillsDeps = {
    resolveLaunchArgs: () => [],
    resolveWorkspacePath: async () => base,
    resolveEnvironment: async () => ({ PATH: '/bin' }),
    resolveCommand: () => ({ command: '/bin/codex', prefixArgs: [] }),
    skillRoots: async ({ location: { workspaceId } }) =>
      workspaceId !== 'plain' && (options.linked?.(workspaceId) ?? true)
        ? [`/links/${workspaceId}`]
        : [],
    // The settle grace ends only when the test says so.
    sleep: () => new Promise<void>((resolve) => settles.push(resolve)),
    runSession: async (_invocation, body) => {
      const probe: Probe = { roots: null, calls: [] }
      probes.push(probe)
      live += 1
      peak = Math.max(peak, live)
      try {
        return await body({
          notify: () => {},
          request: async (method, params) => {
            probe.calls.push(method)
            if (method === 'skills/extraRoots/set') {
              const roots = strings(params?.extraRoots)
              await options.setRoots?.(roots)
              probe.roots = roots
              return {}
            }
            await options.list?.(probe.roots)
            const cwds = strings(params?.cwds)
            return {
              data: cwds.map((cwd) => ({
                cwd,
                skills: (probe.roots ?? []).map((root) => ({
                  name: root.split('/').at(-1),
                  path: `${root}/SKILL.md`
                }))
              }))
            }
          }
        })
      } finally {
        live -= 1
      }
    }
  }
  const settle = (all?: 'all'): void => {
    for (const end of all ? settles.splice(0) : settles.splice(0, 1)) {
      end()
    }
  }
  return { deps, probes, peak: () => peak, settle }
}

const skills = (commands: readonly { name: string; kind: string; path?: string }[] | undefined) =>
  commands?.filter((command) => command.kind === 'skill')

it("lists a bot's linked skills from a probe that set only its roots, once, before listing", async () => {
  const { deps, probes, settle } = codexHost()
  const catalog = createCodexAtRestSkillCatalog(deps)
  const a = await catalog.settled(chat('bot-a'), 5_000, true)
  const b = await catalog.settled(chat('bot-b'), 5_000, true)
  settle()
  const plain = await catalog.settled(chat('plain'), 5_000, true)
  settle('all')

  expect(skills(a)).toEqual([{ name: 'bot-a', kind: 'skill', path: '/links/bot-a/SKILL.md' }])
  expect(skills(b)).toEqual([{ name: 'bot-b', kind: 'skill', path: '/links/bot-b/SKILL.md' }])
  expect(skills(plain)).toEqual([])
  expect(probes).toEqual([
    { roots: ['/links/bot-a'], calls: ['skills/extraRoots/set', 'skills/list'] },
    { roots: ['/links/bot-b'], calls: ['skills/extraRoots/set', 'skills/list'] },
    { roots: null, calls: ['skills/list'] }
  ])
  catalog.dispose()
})

it('lists nothing from a probe whose roots setup failed, for every chat that joins it', async () => {
  const { deps, probes, settle } = codexHost({
    setRoots: async () => {
      throw new Error('codex app-server skills/extraRoots/set timed out')
    }
  })
  const catalog = createCodexAtRestSkillCatalog(deps)
  expect(await catalog.settled(chat('bot-a'), 5_000, true)).toBeUndefined()
  // Another chat of the same bot, while that probe settles.
  const sibling: AgentSessionRecord = { ...chat('bot-a'), sessionId: 'chat-bot-a-2' }
  catalog.retireContext('bot-a')
  expect(await catalog.settled(sibling, 5_000, true)).toBeUndefined()

  expect(probes).toEqual([{ roots: null, calls: ['skills/extraRoots/set'] }])
  settle('all')
  catalog.dispose()
})

it('lists what a Codex without skill roots loads', async () => {
  const { deps, probes, settle } = codexHost({
    setRoots: async () => {
      throw new CodexAppServerUnsupportedError(
        'codex app-server does not support skills/extraRoots/set'
      )
    }
  })
  const catalog = createCodexAtRestSkillCatalog(deps)
  const commands = await catalog.settled(chat('bot-a'), 5_000, true)
  settle('all')

  expect(probes[0]?.calls).toEqual(['skills/extraRoots/set', 'skills/list'])
  expect(commands).toBeDefined()
  expect(skills(commands)).toEqual([])
  catalog.dispose()
})

it('runs two probes at most, starts a menu that asks before queued eager reads, and skips abandoned ones', async () => {
  const { deps, probes, peak, settle } = codexHost()
  let queued = 0
  const catalog = createCodexAtRestSkillCatalog({
    ...deps,
    // Read last, just before a scan joins the pool.
    resolveLaunchArgs: () => {
      queued += 1
      return []
    }
  })
  catalog.read(chat('bot-1'))
  catalog.read(chat('bot-2'))
  await vi.waitFor(() => expect(probes.filter((probe) => probe.roots).length).toBe(2))
  for (const bot of ['bot-3', 'bot-4', 'bot-5', 'bot-6']) {
    catalog.read(chat(bot))
  }
  await vi.waitFor(() => expect(queued).toBe(6))
  await new Promise((resolve) => setImmediate(resolve))
  // A menu opens on bot-6 while bot-3..6 wait; bot-4's chat goes away.
  const asked = catalog.settled(chat('bot-6'), 60_000, true)
  catalog.retireContext('bot-4')

  const started = async (count: number): Promise<string | undefined> => {
    settle()
    await vi.waitFor(() => expect(probes[count - 1]?.roots).toBeTruthy())
    return probes[count - 1]?.roots?.[0]
  }
  expect(await started(3)).toBe('/links/bot-6')
  expect(skills(await asked)).toEqual([
    { name: 'bot-6', kind: 'skill', path: '/links/bot-6/SKILL.md' }
  ])
  expect([await started(4), await started(5)].sort()).toEqual(['/links/bot-3', '/links/bot-5'])
  settle('all')
  expect(peak()).toBe(2)
  expect(probes.map((probe) => probe.roots?.[0])).not.toContain('/links/bot-4')
  catalog.dispose()
})

it('never shows rows an unlink retired mid-list, and shows no list when the reread fails', async () => {
  let linked = true
  const listed = Promise.withResolvers<void>()
  const { deps, probes, settle } = codexHost({
    linked: () => linked,
    list: async (roots) => {
      if (roots) {
        await listed.promise
      } else {
        throw new Error('codex app-server skills/list failed: io error')
      }
    }
  })
  const catalog = createCodexAtRestSkillCatalog(deps)
  const menu = catalog.settled(chat('bot-a'), 5_000, true)
  await vi.waitFor(() => expect(probes[0]?.calls).toContain('skills/list'))
  linked = false
  catalog.retireContext('bot-a')
  listed.resolve()

  expect(await menu).toBeUndefined()
  expect(probes.map((probe) => probe.roots)).toEqual([['/links/bot-a'], null])
  settle('all')
  catalog.dispose()
})
