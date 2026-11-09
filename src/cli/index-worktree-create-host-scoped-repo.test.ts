import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

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
  removeEnvironment: vi.fn(),
  resolveEnvironment: vi.fn()
}))

vi.mock('../shared/remote-runtime/host-store/runtime-environment-store', () => ({
  listEnvironments: listEnvironmentsMock
}))

vi.mock('child_process', async () => {
  const { createChildProcessModuleMock } = await import('./index-test-harness.js')
  return createChildProcessModuleMock(spawnMock)
})

import { main } from './index'
import {
  buildWorktree,
  noFolderWorkspacesFixture,
  okFixture,
  queueFixtures,
  worktreeListFixture
} from './test-fixtures'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'

const SSH_CALLER = {
  ORCA_ORCHESTRATION_COMPATIBILITY_HOST_KIND: 'ssh',
  ORCA_ORCHESTRATION_COMPATIBILITY_HOST_ID: 'box-b',
  ORCA_ORCHESTRATION_COMPATIBILITY_HOST_INCARNATION: 'inc-1',
  ORCA_ORCHESTRATION_COMPATIBILITY_ATTACHMENT: 'att-1'
}

describe('worktree create from a worktree another host shares an id with', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  afterEach(() => {
    for (const key of Object.keys(SSH_CALLER)) {
      delete process.env[key]
    }
  })

  it('infers the repo while the parent stays the exact host-scoped identity', async () => {
    Object.assign(process.env, SSH_CALLER)
    queueFixtures(
      callMock,
      worktreeListFixture([
        {
          ...buildWorktree('/srv/app', 'main', 'abc', 'repo-1'),
          hostId: 'ssh:box-a',
          identity: { key: 'wt2:a' }
        },
        {
          ...buildWorktree('/srv/app', 'main', 'abc', 'repo-1'),
          hostId: 'ssh:box-b',
          identity: { key: 'wt2:b' }
        }
      ]),
      noFolderWorkspacesFixture(),
      okFixture('req_create', {
        worktree: buildWorktree('/srv/app-child', 'child', 'abc', 'repo-1'),
        lineage: null,
        warnings: []
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['worktree', 'create', '--name', 'child', '--json'], '/srv/app/src')

    expect(callMock).toHaveBeenNthCalledWith(
      3,
      'worktree.create',
      expect.objectContaining({ repo: 'id:repo-1', cwdParentWorktree: 'identity:wt2:b' })
    )
  })

  it('infers checkout ownership independently of workspace identity and catalog order', async () => {
    const path = resolve('/tmp/sta-12478')
    const root = buildWorktree(path, 'main', 'abc', 'repo-a')
    const other = buildWorktree(path, 'main', 'abc', 'repo-b')
    const sibling = { ...root, id: `${root.id}::workspace:11111111-1111-4111-8111-111111111111` }
    const folder = { ...root, id: 'folder:f1', repoId: 'folder-workspace:group-1' }
    const nfc = buildWorktree(join(path, 'café'), 'main', 'abc', 'repo-a')
    const nfd = buildWorktree(join(path, 'cafe\u0301'), 'main', 'abc', 'repo-b')
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode
    const cases = [
      { rows: [nfc, nfd], caller: undefined, repo: undefined, cwd: nfc.path },
      { rows: [nfc, nfd], caller: nfc.id, repo: 'repo-a', cwd: nfc.path },
      { rows: [nfc, nfd], caller: nfc.id, repo: 'repo-a', cwd: nfc.path, parent: 'active' },
      { rows: [nfc, nfd], caller: nfc.id, repo: 'repo-a', cwd: nfc.path, parent: 'current' },
      { rows: [root, { ...other, path: join(path, 'nested') }], caller: undefined, repo: 'repo-b' },
      { rows: [root, other], caller: undefined, repo: undefined },
      { rows: [root, other], caller: other.id, repo: 'repo-b' },
      { rows: [root, other], caller: 'missing::workspace', repo: undefined },
      { rows: [root, root], caller: undefined, repo: 'repo-a' },
      { rows: [root, sibling], caller: undefined, repo: 'repo-a' },
      { rows: [root, folder], caller: undefined, repo: 'repo-a' },
      {
        rows: [root, { ...folder, path: join(path, 'nested') }],
        caller: undefined,
        repo: 'repo-a'
      },
      {
        rows: [
          { ...root, head: '', branch: '' },
          { ...sibling, head: '', branch: '' }
        ],
        caller: undefined,
        repo: 'repo-a'
      },
      { rows: [root, folder], caller: root.id, repo: 'repo-a' },
      { rows: [root, folder], caller: folder.id, repo: 'repo-a' },
      { rows: [root, { ...root, hostId: 'runtime:other' }], caller: undefined, repo: undefined }
    ]
    try {
      for (const testCase of cases) {
        for (const rows of [testCase.rows, testCase.rows.toReversed()]) {
          callMock.mockReset()
          logSpy.mockClear()
          errSpy.mockClear()
          process.exitCode = priorExitCode
          if (testCase.caller) {
            process.env.ORCA_WORKTREE_ID = testCase.caller
          } else {
            delete process.env.ORCA_WORKTREE_ID
          }
          callMock.mockImplementation(async (method: string) =>
            method === 'worktree.list'
              ? worktreeListFixture(rows)
              : okFixture('create', {
                  worktree: buildWorktree(join(path, 'child'), 'child', 'abc', testCase.repo),
                  lineage: null,
                  warnings: []
                })
          )
          await main(
            [
              'worktree',
              'create',
              '--name',
              'child',
              ...(testCase.parent ? ['--parent-worktree', testCase.parent] : ['--no-parent']),
              '--json'
            ],
            testCase.cwd ?? join(path, 'nested', 'src')
          )
          if (testCase.repo) {
            expect(process.exitCode).toBe(priorExitCode)
            expect(JSON.parse(String(logSpy.mock.calls[0]?.[0])).result.worktree.repoId).toBe(
              testCase.repo
            )
            expect(callMock).toHaveBeenCalledWith(
              'worktree.create',
              expect.objectContaining({
                repo: `id:${testCase.repo}`,
                noParent: !testCase.parent,
                ...(testCase.parent ? { parentWorktree: `id:${testCase.caller}` } : {})
              })
            )
          } else {
            expect(callMock).not.toHaveBeenCalledWith('worktree.create', expect.anything())
            expect(process.exitCode).toBe(1)
            const printed = [...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')
            expect(printed).toContain('selector_ambiguous')
            expect(printed).toContain('Choose the project with --repo or --project')
          }
        }
      }
      // An explicit target keeps optional-parent inference; active/current refuse a two-owner path.
      delete process.env.ORCA_WORKTREE_ID
      for (const parent of [undefined, 'active', 'current']) {
        callMock.mockReset()
        process.exitCode = priorExitCode
        callMock.mockImplementation(async (method: string) => {
          if (method === 'worktree.list') {
            return worktreeListFixture([root, other])
          }
          return okFixture('create', {
            worktree: buildWorktree(join(path, 'child'), 'child'),
            lineage: null,
            warnings: []
          })
        })
        await main(
          [
            'worktree',
            'create',
            '--name',
            'child',
            '--repo',
            'id:repo-b',
            ...(parent ? ['--parent-worktree', parent] : []),
            '--json'
          ],
          path
        )
        // Two registrations own the path: an explicit current refuses, inference flags the tie.
        if (parent) {
          expect(process.exitCode).toBe(1)
          expect(callMock).not.toHaveBeenCalledWith('worktree.create', expect.anything())
          process.exitCode = priorExitCode
          continue
        }
        expect(process.exitCode).toBe(priorExitCode)
        expect(callMock).toHaveBeenCalledWith(
          'worktree.create',
          expect.objectContaining({
            repo: 'id:repo-b',
            cwdParentWorktree: `id:${root.id}`,
            cwdParentAmbiguous: true
          })
        )
      }
      // A unique project retains the legacy parent hint and carries the unresolved owners.
      callMock.mockReset()
      queueFixtures(
        callMock,
        worktreeListFixture([sibling, root]),
        okFixture('create', {
          worktree: buildWorktree(join(path, 'child'), 'child'),
          lineage: null,
          warnings: []
        })
      )
      await main(['worktree', 'create', '--name', 'child', '--json'], path)
      expect(callMock).toHaveBeenCalledWith(
        'worktree.create',
        expect.objectContaining({
          repo: 'id:repo-a',
          cwdParentWorktree: `id:${sibling.id}`,
          cwdParentAmbiguous: true
        })
      )
    } finally {
      process.exitCode = priorExitCode
    }
  })

  it('requires an explicit Git destination when a native folder supplies only parent lineage', async () => {
    const path = resolve('/tmp/plain-folder')
    const folder = {
      ...buildWorktree(path, ''),
      id: 'folder:f1',
      repoId: 'folder-workspace:group-1'
    }
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const priorExitCode = process.exitCode
    try {
      for (const rows of [[], [folder]]) {
        for (const explicit of [false, true]) {
          callMock.mockReset()
          logSpy.mockClear()
          process.exitCode = priorExitCode
          callMock.mockImplementation(async (method: string) =>
            method === 'worktree.list'
              ? worktreeListFixture(rows)
              : okFixture('create', {
                  worktree: buildWorktree(join(path, 'child'), 'child', 'abc', 'repo-a'),
                  lineage: null,
                  warnings: []
                })
          )
          await main(
            [
              'worktree',
              'create',
              '--name',
              'folder-child',
              '--parent-worktree',
              'folder:f1',
              ...(explicit ? ['--repo', 'id:repo-a'] : []),
              '--json'
            ],
            join(path, 'src')
          )
          if (explicit) {
            expect(process.exitCode).toBe(priorExitCode)
            expect(callMock).toHaveBeenCalledWith(
              'worktree.create',
              expect.objectContaining({
                repo: 'id:repo-a',
                parentWorkspace: 'folder:f1'
              })
            )
          } else {
            expect(process.exitCode).toBe(1)
            expect(callMock).not.toHaveBeenCalledWith('worktree.create', expect.anything())
            expect(logSpy.mock.calls.flat().join('\n')).toContain('Missing repo selector')
          }
        }
      }
    } finally {
      process.exitCode = priorExitCode
    }
  })

  it.each(['folder:f1', 'active'])(
    'lists the Git repositories of a folder parent when create has no repo (--parent-worktree %s)',
    async (parent) => {
      const path = resolve('/tmp/feature-folder')
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const priorExitCode = process.exitCode
      const lists: Record<string, unknown> = {
        'worktree.list': worktreeListFixture([]).result,
        'folderWorkspace.list': {
          folderWorkspaces: [{ id: 'f1', projectGroupId: 'g1', folderPath: path, name: 'feature' }]
        },
        'projectGroup.list': { groups: [{ id: 'g1', name: 'feature', parentPath: path }] },
        'repo.list': {
          repos: [
            { id: 'repo-api', path: join(path, 'api'), displayName: 'api' },
            { id: 'elsewhere', path: resolve('/tmp/other'), displayName: 'other' }
          ]
        }
      }
      try {
        callMock.mockImplementation(async (method: string) =>
          okFixture(method, lists[method] ?? {})
        )
        await main(
          ['worktree', 'create', '--name', 'fix-login', '--parent-worktree', parent],
          join(path, 'api')
        )
        const output = [...errorSpy.mock.calls, ...logSpy.mock.calls].flat().join('\n')
        expect(process.exitCode).toBe(1)
        expect(callMock).not.toHaveBeenCalledWith('worktree.create', expect.anything())
        expect(output).toContain('--repo id:repo-api')
        expect(output).not.toContain('id:elsewhere')
      } finally {
        process.exitCode = priorExitCode
      }
    }
  )
})
