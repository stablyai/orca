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

vi.mock('../shared/remote-runtime/host-store/runtime-environment-store', () => ({
  listEnvironments: listEnvironmentsMock
}))

vi.mock('child_process', async () => {
  const { createChildProcessModuleMock } = await import('./index-test-harness.js')
  return createChildProcessModuleMock(spawnMock)
})

import { main } from './index'
import { buildWorktree, okFixture } from './test-fixtures'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'
import { WORKTREE_LINKED_ITEMS_DELTA_RUNTIME_CAPABILITY } from '../shared/workspace-attachments/workspace-attachment-capabilities'

const SET_TARGET = ['--worktree', 'id:repo::/tmp/repo/child']
const crossRepoPR = {
  provider: 'github',
  type: 'pr',
  number: 2383,
  url: 'https://github.com/relayto/relayto-frontend/pull/2383'
}

function routeCalls(capabilities: string[], linkedItems: unknown[] = []): void {
  const worktree = { ...buildWorktree('/tmp/repo/child', 'linked-task'), linkedItems }
  callMock.mockImplementation(async (method: string) =>
    method === 'status.get'
      ? okFixture('status', { capabilities })
      : okFixture(method, { worktree })
  )
  vi.spyOn(console, 'error').mockImplementation(() => {})
}

function printed(): () => string {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  return () => logSpy.mock.calls.flat().join('\n')
}

describe('worktree set --pr <url> links a PR from any repository', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('adds the PR reference beside existing links and selects it', async () => {
    routeCalls([WORKTREE_LINKED_ITEMS_DELTA_RUNTIME_CAPABILITY])
    printed()

    await main(
      [
        'worktree',
        'set',
        ...SET_TARGET,
        '--pr',
        `${crossRepoPR.url}/files?diff=split#top`,
        '--json'
      ],
      '/tmp/repo'
    )

    const set = callMock.mock.calls.find(([method]) => method === 'worktree.set')?.[1]
    expect(set).toMatchObject({
      worktree: 'id:repo::/tmp/repo/child',
      linkedPR: 2383,
      linkedItemsBase: [],
      linkedItems: [crossRepoPR]
    })
    expect(set).not.toHaveProperty('linkedPRReference')
  })

  it('refuses to hide the requested PR behind another linked URL with its number', async () => {
    const other = { ...crossRepoPR, url: 'https://github.com/relayto/relayto-api/pull/2383' }
    routeCalls([WORKTREE_LINKED_ITEMS_DELTA_RUNTIME_CAPABILITY], [other])
    const output = printed()

    await main(['worktree', 'set', ...SET_TARGET, '--pr', crossRepoPR.url, '--json'], '/tmp/repo')

    expect(callMock).not.toHaveBeenCalledWith('worktree.set', expect.anything())
    expect(output()).toContain(`orca reference remove ${other.url}`)
    expect(process.exitCode).toBe(1)
  })

  it('refuses a host that would replace every link instead of merging one in', async () => {
    routeCalls([])
    const output = printed()

    await main(['worktree', 'set', ...SET_TARGET, '--pr', crossRepoPR.url, '--json'], '/tmp/repo')

    expect(callMock).not.toHaveBeenCalledWith('worktree.set', expect.anything())
    expect(output()).toContain('incompatible_runtime')
    expect(process.exitCode).toBe(1)
  })

  it.each([
    'https://gitlab.com/group/project/-/merge_requests/2383',
    'https://github.com/relayto/relayto-frontend/issues/2383',
    'https://linear.app/acme/issue/STA-1'
  ])('refuses a non-GitHub-PR URL %s before any RPC', async (url) => {
    const output = printed()
    await main(['worktree', 'set', ...SET_TARGET, '--pr', url, '--json'], '/tmp/repo')
    expect(callMock).not.toHaveBeenCalled()
    expect(output()).toContain('invalid_argument')
    expect(process.exitCode).toBe(1)
  })

  it('create points a PR URL at --reference instead of dropping its repository', async () => {
    const output = printed()
    await main(
      [
        'worktree',
        'create',
        '--repo',
        'id:repo',
        '--name',
        'linked-task',
        '--no-parent',
        '--pr',
        crossRepoPR.url,
        '--json'
      ],
      '/tmp/repo'
    )
    expect(callMock).not.toHaveBeenCalled()
    expect(output()).toContain('--reference <url>')
    expect(process.exitCode).toBe(1)
  })
})
