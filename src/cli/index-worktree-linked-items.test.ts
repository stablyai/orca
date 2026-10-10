import { describe, expect, it, vi } from 'vitest'

const {
  callMock,
  runtimeClientConstructorMock,
  serveOrcaAppMock,
  getDefaultUserDataPathMock,
  addEnvironmentFromPairingCodeMock,
  listEnvironmentsMock,
  spawnMock
} = vi.hoisted(() => ({
  callMock: vi.fn(),
  runtimeClientConstructorMock: vi.fn(),
  serveOrcaAppMock: vi.fn(),
  getDefaultUserDataPathMock: vi.fn(() => '/tmp/orca-user-data'),
  addEnvironmentFromPairingCodeMock: vi.fn(),
  listEnvironmentsMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('./runtime-client', async () => {
  const { createRuntimeClientModuleMock } = await import('./index-test-harness.js')
  return createRuntimeClientModuleMock({
    callMock,
    runtimeClientConstructorMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock
  })
})

vi.mock('./runtime/environments', () => ({
  addEnvironmentFromPairingCode: addEnvironmentFromPairingCodeMock,
  listEnvironments: listEnvironmentsMock,
  removeEnvironment: vi.fn(),
  resolveEnvironment: vi.fn()
}))

vi.mock('child_process', async () => {
  const { createChildProcessModuleMock } = await import('./index-test-harness.js')
  return createChildProcessModuleMock(spawnMock)
})

import { main } from './index'
import { buildWorktree, okFixture, queueFixtures } from './test-fixtures'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'

const LINK_FLAGS = [
  { flag: 'pr', field: 'linkedPR', value: '42', number: 42 },
  { flag: 'gitlab-issue', field: 'linkedGitLabIssue', value: '#53', number: 53 },
  { flag: 'gitlab-mr', field: 'linkedGitLabMR', value: '!77', number: 77 }
] as const

function targetArgs(command: 'create' | 'set'): string[] {
  return command === 'create'
    ? ['--repo', 'id:repo', '--name', 'linked-task', '--no-parent']
    : ['--worktree', 'id:repo::/tmp/repo/child']
}

describe('worktree issue and review metadata flags', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  for (const command of ['create', 'set'] as const) {
    it.each(LINK_FLAGS)(`${command} sends --$flag to its own metadata field`, async (link) => {
      queueFixtures(
        callMock,
        okFixture('req_link', {
          worktree: buildWorktree('/tmp/repo/child', 'linked-task'),
          lineage: null,
          warnings: []
        })
      )
      vi.spyOn(console, 'log').mockImplementation(() => {})
      vi.spyOn(console, 'error').mockImplementation(() => {})

      await main(
        ['worktree', command, ...targetArgs(command), `--${link.flag}`, link.value, '--json'],
        '/tmp/repo'
      )

      expect(callMock).toHaveBeenCalledTimes(1)
      const [method, payload] = callMock.mock.calls[0]
      expect(method).toBe(`worktree.${command}`)
      expect(payload).toHaveProperty(link.field, link.number)
      for (const other of LINK_FLAGS.filter((entry) => entry.field !== link.field)) {
        expect(payload).not.toHaveProperty(other.field)
      }
    })

    it(`${command} omits all link keys when their flags are absent`, async () => {
      queueFixtures(
        callMock,
        okFixture('req_unrelated', { worktree: buildWorktree('/tmp/repo/child', 'linked-task') })
      )
      vi.spyOn(console, 'log').mockImplementation(() => {})
      await main(['worktree', command, ...targetArgs(command), '--json'], '/tmp/repo')
      expect(callMock).toHaveBeenCalledTimes(1)
      for (const link of LINK_FLAGS) {
        expect(callMock.mock.calls[0][1]).not.toHaveProperty(link.field)
      }
    })
  }

  it.each(LINK_FLAGS)('set --$flag null clears only its own link', async (link) => {
    queueFixtures(
      callMock,
      okFixture('req_clear', { worktree: buildWorktree('/tmp/repo/child', 'linked-task') })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(
      ['worktree', 'set', ...targetArgs('set'), `--${link.flag}`, 'null', '--json'],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock.mock.calls[0][1]).toHaveProperty(link.field, null)
    for (const other of LINK_FLAGS.filter((entry) => entry.field !== link.field)) {
      expect(callMock.mock.calls[0][1]).not.toHaveProperty(other.field)
    }
  })

  it.each(LINK_FLAGS)('create refuses --$flag null before resolving a selector', async (link) => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(
      ['worktree', 'create', '--name', 'linked-task', `--${link.flag}`, 'null', '--json'],
      '/tmp/not-managed'
    )
    expect(callMock).not.toHaveBeenCalled()
    expect(logSpy.mock.calls.flat().join('\n')).toContain(`Omit --${link.flag} on create`)
    expect(process.exitCode).toBe(1)
  })

  it.each([
    ['pr', '0'],
    ['pr', '-1'],
    ['pr', '1.5'],
    ['pr', '1e2'],
    ['pr', '0x2a'],
    ['pr', '9007199254740992'],
    ['pr', 'https://github.com/group/project/issues/42'],
    ['gitlab-issue', '!53'],
    ['gitlab-mr', '#77'],
    ['gitlab-issue', 'https://gitlab.com/group/project/-/merge_requests/53'],
    ['gitlab-mr', 'https://gitlab.com/group/project/-/work_items/77'],
    ['gitlab-issue', 'https://github.com/group/project/issues/53'],
    ['gitlab-mr', 'ftp://gitlab.com/group/project/-/merge_requests/77'],
    ['gitlab-issue', '9007199254740992'],
    ['gitlab-mr', '9'.repeat(400)],
    ['gitlab-mr', ''],
    ['gitlab-issue', '   ']
  ])('refuses --%s %s before resolving active or making RPC', async (flag, value) => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(
      ['worktree', 'set', '--worktree', 'active', `--${flag}`, value, '--json'],
      '/tmp/repo'
    )
    expect(callMock).not.toHaveBeenCalled()
    expect(logSpy.mock.calls.flat().join('\n')).toContain('invalid_argument')
    expect(process.exitCode).toBe(1)
  })

  it.each(LINK_FLAGS)('refuses a missing --$flag value before RPC', async (link) => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(['worktree', 'set', '--worktree', 'active', `--${link.flag}`, '--json'], '/tmp/repo')
    expect(callMock).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })

  it.each(LINK_FLAGS)('accepts the greatest safe integer for --$flag', async (link) => {
    queueFixtures(
      callMock,
      okFixture('req_safe', { worktree: buildWorktree('/tmp/repo/child', 'linked-task') })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(
      ['worktree', 'set', ...targetArgs('set'), `--${link.flag}`, '9007199254740991', '--json'],
      '/tmp/repo'
    )
    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock.mock.calls[0][1]).toHaveProperty(link.field, Number.MAX_SAFE_INTEGER)
  })

  it.each(['create', 'set'])(
    '%s help describes the new flags and set-only clears',
    async (command) => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      await main(['worktree', command, '--help'])
      const output = logSpy.mock.calls.flat().join('\n')
      expect(output).toContain(command === 'create' ? '--pr <number>' : '--pr <number|null>')
      for (const flag of ['gitlab-issue', 'gitlab-mr']) {
        expect(output).toContain(
          command === 'create' ? `--${flag} <number|url>` : `--${flag} <number|url|null>`
        )
      }
      expect(callMock).not.toHaveBeenCalled()
    }
  )
})
