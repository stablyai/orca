import { win32 } from 'node:path'
import type * as NodePath from 'node:path'
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

// Exercise production UNC resolution on every CI host; keep matching and elections real.
vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof NodePath>()
  return { ...actual, resolve: actual.win32.resolve }
})

import { main } from './index'
import {
  selectEnclosingRepoOnHost,
  selectEnclosingWorktreeSelectionOnHost
} from './caller-host-worktree-selection'
import { buildWorktree, okFixture, worktreeListFixture } from './test-fixtures'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'
import { toSshExecutionHostId } from '../shared/execution-host'

const UPPER = String.raw`\\wsl.localhost\Ubuntu\home\Alice\App`
const LOWER = String.raw`\\wsl$\Ubuntu\home\alice\app`
const upper = buildWorktree(UPPER, 'main', 'abc', 'repo-a')
const lower = buildWorktree(LOWER, 'main', 'abc', 'repo-b')

describe('WSL enclosing selection with Windows path resolution on every platform', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it.each([
    [UPPER, String.raw`\\wsl$\ubuntu\home\Alice\App\src`],
    ['\\\\wsl$\\Ubuntu\\home\\Alice\\App\\', '//wsl.localhost/ubuntu/home/Alice/App/src'],
    ['//wsl.localhost/Ubuntu/home/Alice/App/', String.raw`\\wsl$\Ubuntu\home\Alice\App\src`]
  ])('retains original identity for uppercase-tail aliases: %s', (root, cwd) => {
    const row = buildWorktree(root, 'main', 'abc', 'repo-a')
    for (const caller of [undefined, row.id]) {
      expect(selectEnclosingWorktreeSelectionOnHost([row], cwd, 'local', caller)).toEqual({
        selector: `id:${row.id}`,
        worktreeId: row.id
      })
      expect(selectEnclosingRepoOnHost([row], cwd, 'local', caller)).toBe('repo-a')
    }
  })

  it('excludes case-distinct directories before caller preference in either order', () => {
    for (const rows of [
      [upper, lower],
      [lower, upper]
    ]) {
      for (const owner of [upper, lower]) {
        for (const caller of [undefined, upper.id, lower.id]) {
          const cwd = win32.join(owner.path, 'src')
          expect(selectEnclosingWorktreeSelectionOnHost(rows, cwd, 'local', caller)).toEqual({
            selector: `id:${owner.id}`,
            worktreeId: owner.id
          })
          expect(selectEnclosingRepoOnHost(rows, cwd, 'local', caller)).toBe(owner.repoId)
        }
      }
    }
    const wrongDistro = { ...upper, path: UPPER.replace('Ubuntu', 'Debian') }
    const wrongHost = { ...upper, hostId: toSshExecutionHostId('other') }
    expect(
      selectEnclosingWorktreeSelectionOnHost([wrongDistro, wrongHost], UPPER, 'local')
    ).toBeUndefined()
    expect(selectEnclosingRepoOnHost([wrongDistro, wrongHost], UPPER, 'local')).toBeUndefined()
  })

  it('keeps canonical caller ties and nested checkout priority in both elections', () => {
    const nfc = buildWorktree('C:\\projects\\café', 'main', 'abc', 'repo-a')
    const nfd = buildWorktree('C:\\projects\\cafe\u0301', 'main', 'abc', 'repo-b')
    const nested = buildWorktree(win32.join(nfc.path, 'nested'), 'main', 'abc', 'repo-child')
    for (const rows of [
      [nfc, nfd],
      [nfd, nfc]
    ]) {
      expect(
        selectEnclosingWorktreeSelectionOnHost(rows, nfc.path, 'local', nfc.id)?.worktreeId
      ).toBe(nfc.id)
      expect(selectEnclosingRepoOnHost(rows, nfc.path, 'local', nfc.id)).toBe('repo-a')
      expect(() => selectEnclosingRepoOnHost(rows, nfc.path, 'local')).toThrow('Choose the project')
      for (const nestedRows of [
        [...rows, nested],
        [nested, ...rows]
      ]) {
        const cwd = win32.join(nested.path, 'src')
        expect(
          selectEnclosingWorktreeSelectionOnHost(nestedRows, cwd, 'local', nfc.id)?.worktreeId
        ).toBe(nested.id)
        expect(selectEnclosingRepoOnHost(nestedRows, cwd, 'local', nfc.id)).toBe('repo-child')
      }
    }
  })

  it.each([
    { owner: upper, catalog: [upper], caller: undefined },
    { owner: upper, catalog: [upper, lower], caller: lower.id },
    { owner: lower, catalog: [upper, lower], caller: undefined },
    { owner: lower, catalog: [upper, lower], caller: upper.id },
    { owner: lower, catalog: [upper, lower], caller: lower.id }
  ])(
    'forwards the containing owner through current, parent and scoped CLI routes: $owner.repoId / $caller',
    async ({ owner, catalog, caller }) => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const priorExitCode = process.exitCode
      const selector = `id:${owner.id}`
      const child = buildWorktree(win32.join(owner.path, 'child'), 'child', 'abc', owner.repoId)
      const commands = [
        { args: ['worktree', 'current'], method: 'worktree.show', target: { worktree: selector } },
        {
          args: ['worktree', 'show', '--worktree', 'current'],
          method: 'worktree.show',
          target: { worktree: selector }
        },
        ...['active', 'current'].map((parent) => ({
          args: [
            'worktree',
            'create',
            '--name',
            'child',
            '--repo',
            'id:explicit-destination',
            '--parent-worktree',
            parent
          ],
          method: 'worktree.create',
          target: { repo: 'id:explicit-destination', parentWorktree: selector }
        })),
        {
          args: ['worktree', 'create', '--name', 'child', '--parent-worktree', 'current'],
          method: 'worktree.create',
          target: { repo: `id:${owner.repoId}`, parentWorktree: selector }
        },
        {
          args: ['worktree', 'create', '--name', 'child'],
          method: 'worktree.create',
          target: {
            repo: `id:${owner.repoId}`,
            cwdParentWorktree: selector,
            ...(caller ? { envParentWorkspace: `worktree:${caller}` } : {})
          }
        },
        ...[[], ['--worktree', 'current']].map((scope) => ({
          args: ['snapshot', ...scope],
          method: 'browser.snapshot',
          target: { worktree: selector }
        })),
        {
          args: ['terminal', 'read'],
          method: 'terminal.resolveActive',
          target: { worktree: selector }
        }
      ]
      try {
        if (caller) {
          process.env.ORCA_WORKTREE_ID = caller
        }
        for (const rows of [catalog, catalog.toReversed()]) {
          for (const command of commands) {
            callMock.mockReset()
            logSpy.mockClear()
            process.exitCode = priorExitCode
            callMock.mockImplementation(async (method: string) => {
              if (method === 'worktree.list') {
                return worktreeListFixture(rows)
              }
              if (method === 'worktree.show') {
                return okFixture('show', { worktree: owner })
              }
              if (method === 'worktree.create') {
                return okFixture('create', { worktree: child, lineage: null, warnings: [] })
              }
              if (method === 'terminal.resolveActive') {
                return okFixture('terminal', { handle: 'terminal-1' })
              }
              return okFixture('scoped', { terminal: { text: 'ready' }, snapshot: 'ready' })
            })
            await main([...command.args, '--json'], win32.join(owner.path, 'src'))
            expect(
              process.exitCode,
              JSON.stringify({
                args: [...command.args, '--json'],
                cwd: win32.join(owner.path, 'src'),
                caller: caller ?? null,
                catalogIds: rows.map((row) => row.id),
                output: JSON.stringify(logSpy.mock.calls).slice(0, 4000),
                calls: JSON.stringify(callMock.mock.calls).slice(0, 4000)
              })
            ).toBe(priorExitCode)
            expect(callMock).toHaveBeenCalledWith(
              command.method,
              expect.objectContaining(command.target)
            )
            if (command.method === 'worktree.show') {
              expect(JSON.parse(String(logSpy.mock.calls[0]?.[0])).result.worktree).toMatchObject({
                id: owner.id,
                path: owner.path
              })
            }
            if (command.method === 'terminal.resolveActive') {
              expect(callMock).toHaveBeenCalledWith('terminal.read', {
                terminal: 'terminal-1',
                limit: undefined
              })
            }
          }
        }
      } finally {
        process.exitCode = priorExitCode
      }
    }
  )
})
