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

describe('orca worktree set --manual-order', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it.each(['-12', '0', '2.5', '100'])('forwards finite rank %s as a number', async (rank) => {
    queueFixtures(
      callMock,
      okFixture('req_rank', { worktree: buildWorktree('/tmp/repo/child', 'feature/child') })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main([
      'worktree',
      'set',
      '--worktree',
      'id:repo::/tmp/repo/child',
      '--manual-order',
      rank,
      '--comment',
      'ranked',
      '--json'
    ])

    expect(callMock).toHaveBeenCalledExactlyOnceWith('worktree.set', {
      worktree: 'id:repo::/tmp/repo/child',
      displayName: undefined,
      linkedIssue: undefined,
      comment: 'ranked',
      workspaceStatus: undefined,
      manualOrder: Number(rank),
      parentWorktree: undefined,
      noParent: false
    })
  })

  it('omits manualOrder when the flag is absent', async () => {
    queueFixtures(
      callMock,
      okFixture('req_comment', { worktree: buildWorktree('/tmp/repo/child', 'feature/child') })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main([
      'worktree',
      'set',
      '--worktree',
      'id:repo::/tmp/repo/child',
      '--comment',
      'unchanged rank',
      '--json'
    ])

    expect(callMock).toHaveBeenCalledExactlyOnceWith('worktree.set', {
      worktree: 'id:repo::/tmp/repo/child',
      displayName: undefined,
      linkedIssue: undefined,
      comment: 'unchanged rank',
      workspaceStatus: undefined,
      parentWorktree: undefined,
      noParent: false
    })
    expect(callMock.mock.calls[0]?.[1]).not.toHaveProperty('manualOrder')
  })

  it.each([
    ['--manual-order'],
    ['--manual-order='],
    ['--manual-order', ''],
    ['--manual-order', 'NaN'],
    ['--manual-order', 'Infinity'],
    ['--manual-order', '-Infinity'],
    ['--manual-order', 'text'],
    ['--manual-order', 'null'],
    ['--manual-order=true'],
    ['--manual-order=false']
  ])('rejects supplied invalid rank %j before selectors or other writes', async (...rankArgs) => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    try {
      await main([
        'worktree',
        'set',
        '--worktree',
        'active',
        ...rankArgs,
        '--display-name',
        'Valid name',
        '--comment',
        'Valid comment',
        '--issue',
        '61',
        '--linear-issue',
        'STA-335',
        '--json'
      ])

      expect(callMock).not.toHaveBeenCalled()
      expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
        '--manual-order'
      )
      expect(process.exitCode).toBe(1)
    } finally {
      process.exitCode = priorExitCode
    }
  })

  it('explains the finite rank and current Manual ordering in public help', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['worktree', 'set', '--help'])

    const help = logSpy.mock.calls.flat().join('\n')
    expect(help).toContain('--manual-order <n>')
    expect(help).toContain('Larger ranks sort earlier in existing Manual mode')
    expect(help).toContain('Omission preserves the current rank')
    expect(callMock).not.toHaveBeenCalled()
  })
})
