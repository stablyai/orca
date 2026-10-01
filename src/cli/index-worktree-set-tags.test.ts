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
import { WORKTREE_TAGS_RUNTIME_CAPABILITY } from '../shared/protocol-version'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'

describe('orca worktree set tags', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  const target = 'id:repo::/tmp/repo/feature'
  const capableStatus = () =>
    okFixture('req_status', { capabilities: [WORKTREE_TAGS_RUNTIME_CAPABILITY] })
  const setResult = (tags: string[]) =>
    okFixture('req_set', { worktree: { ...buildWorktree('/tmp/repo/feature', 'feature'), tags } })

  it('sends --tag and --untag as host-side edits without reading the current set', async () => {
    queueFixtures(callMock, capableStatus(), setResult(['billing', 'api']))
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['worktree', 'set', '--worktree', target, '--tag', 'api', '--untag', 'OLD', '--json'],
      '/tmp/repo'
    )

    expect(callMock).not.toHaveBeenCalledWith('worktree.show', expect.anything())
    const setParams = callMock.mock.calls.find(([method]) => method === 'worktree.set')?.[1]
    expect(setParams).toMatchObject({ worktree: target, addTags: ['api'], removeTags: ['OLD'] })
    expect(setParams).not.toHaveProperty('tags')
  })

  it('replaces the whole set with --tags and clears it with null, without reading it first', async () => {
    queueFixtures(callMock, capableStatus(), setResult([]))
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['worktree', 'set', '--worktree', target, '--tags', 'null', '--json'], '/tmp/repo')

    expect(callMock).not.toHaveBeenCalledWith('worktree.show', expect.anything())
    expect(callMock).toHaveBeenCalledWith(
      'worktree.set',
      expect.objectContaining({ worktree: target, tags: [] })
    )
  })

  it('refuses before writing when the host would silently drop tags', async () => {
    queueFixtures(callMock, okFixture('req_status', { capabilities: [] }))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['worktree', 'set', '--worktree', target, '--tag', 'api', '--json'], '/tmp/repo')

    expect(callMock).not.toHaveBeenCalledWith('worktree.set', expect.anything())
    expect(process.exitCode).toBe(1)
  })

  it('sends no tags key when no tag flag is passed', async () => {
    queueFixtures(callMock, setResult([]))
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['worktree', 'set', '--worktree', target, '--comment', 'x', '--json'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock.mock.calls[0]?.[1]).not.toHaveProperty('tags')
  })
})
