// A Codex chat whose Codex is not running lists what Codex itself would load in the folder the
// chat launches in, from one short-lived app-server that answers at once and then settles.

import { describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import { agentSessionRecordFixture } from '../native-chat/agent-session-record-test-fixture'
import type { CodexAppServerInvocation } from './codex-app-server-session'
import { createCodexAtRestSkillCatalog } from './codex-at-rest-skills-probe'

function floatingCodexChat(sessionId: string, launchDirectory: string) {
  return agentSessionRecordFixture({
    sessionId,
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: '/home/me/.codex' },
    launchDirectory,
    location: { workspaceId: FLOATING_TERMINAL_WORKTREE_ID }
  })
}

describe('a resting Codex chat lists the skills Codex would load', () => {
  it('answers per pinned folder before the probe settles, which then ends the whole tree', async () => {
    const invocations: CodexAppServerInvocation[] = []
    const settling: (() => void)[] = []
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
      resolveCommand: () => '/bin/codex',
      sleep: () => new Promise((resolve) => settling.push(resolve)),
      runSession: async (invocation, body) => {
        invocations.push(invocation)
        return body({
          request: async (_method, params) => {
            const cwds = params?.cwds
            const cwd = Array.isArray(cwds) ? String(cwds[0]) : ''
            const name = cwd.endsWith('one') ? 'first' : 'second'
            return { data: [{ cwd, skills: [{ name, path: `${cwd}/${name}/SKILL.md` }] }] }
          },
          notify: () => {}
        })
      }
    })
    const one = floatingCodexChat('one', '/work/one')
    const two = floatingCodexChat('two', '/work/two')

    expect(catalog.read(one)).toBeUndefined()
    expect(catalog.read(two)).toBeUndefined()
    await Promise.all([catalog.settled(one, 1_000), catalog.settled(two, 1_000)])

    // Both answered while their probes still settle: two folders, two lists.
    expect(settling).toHaveLength(2)
    expect(catalog.read(one)?.filter((row) => row.kind === 'skill')).toEqual([
      { name: 'first', kind: 'skill', path: '/work/one/first/SKILL.md' }
    ])
    expect(catalog.read(two)?.filter((row) => row.kind === 'skill')).toEqual([
      { name: 'second', kind: 'skill', path: '/work/two/second/SKILL.md' }
    ])
    // Saved plugin settings and other config match a real chat; permission flags stay normalized.
    expect(invocations.map((invocation) => invocation.args)).toEqual([
      ['--disable', 'plugins', '-c', 'features.test=true', 'app-server'],
      ['--disable', 'plugins', '-c', 'features.test=true', 'app-server']
    ])
    expect(invocations.map(({ cwd }) => cwd)).toEqual(['/work/one', '/work/two'])
    expect(invocations.every((invocation) => invocation.treeKillOnFinish)).toBe(true)
    expect(invocations[0]?.env).toMatchObject({
      CODEX_HOME: '/home/me/.codex',
      CUSTOM_AGENT_ENV: 'configured'
    })
    expect(invocations[0]?.envToDelete).toEqual(['ORCA_CHAT_SCRATCH_DIR', 'ORCA_CHAT_VISUALS_DIR'])
    settling.forEach((resolve) => resolve())
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
        resolveCommand: () => '/bin/codex',
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
})
