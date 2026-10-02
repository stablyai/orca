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
import { okFixture, queueFixtures } from './test-fixtures'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'

function repoFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'repo-1',
    path: '/tmp/repo',
    displayName: 'orca',
    badgeColor: '#7c3aed',
    addedAt: 1,
    ...overrides
  }
}

function expectRejection(log: { mock: { calls: unknown[][] } }, message: string): void {
  const printed = JSON.parse(String(log.mock.calls.at(-1)?.[0]))
  expect(printed.ok).toBe(false)
  expect(printed.error.code).toBe('invalid_argument')
  expect(printed.error.message).toContain(message)
  expect(process.exitCode).toBe(1)
  process.exitCode = 0
}

function queueHooksRead(
  hookOverrides: Record<string, unknown> = {},
  checkOverrides: Record<string, unknown> = {}
): void {
  queueFixtures(
    callMock,
    okFixture('req_repo_hooks', {
      hasHooksFile: true,
      hooks: { scripts: { setup: 'pnpm install' } },
      setupRunPolicy: 'run-by-default',
      source: 'orca.yaml',
      ...hookOverrides
    }),
    okFixture('req_repo_hooks_check', {
      status: 'ok',
      hasHooks: true,
      hooks: { scripts: { setup: 'pnpm install' } },
      mayNeedUpdate: false,
      ...checkOverrides
    })
  )
}

describe('orca repo hooks', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('reads the local, shared, and effective scripts for one repo', async () => {
    queueFixtures(
      callMock,
      okFixture('req_repo_show', {
        repo: repoFixture({
          hookSettings: {
            mode: 'auto',
            commandSourcePolicy: 'run-both',
            scripts: { setup: 'cp .env.example .env', archive: '' }
          }
        })
      })
    )
    queueHooksRead({
      hooks: { scripts: { setup: 'pnpm install\ncp .env.example .env' } }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['repo', 'hooks', 'show', '--repo', 'orca'], '/tmp/repo')

    expect(callMock).toHaveBeenNthCalledWith(1, 'repo.show', { repo: 'orca' })
    expect(callMock).toHaveBeenNthCalledWith(2, 'repo.hooks', { repo: 'orca' })
    expect(callMock).toHaveBeenNthCalledWith(3, 'repo.hooksCheck', { repo: 'orca' })
    const printed = log.mock.calls.at(-1)?.[0]
    expect(printed).toContain('orca.yaml: present')
    expect(printed).toContain('commandSource: run-both')
    expect(printed).toContain('setup script (local):\n  cp .env.example .env')
    expect(printed).toContain('setup script (orca.yaml):\n  pnpm install')
    expect(printed).toContain('setup script (effective):\n  pnpm install\n  cp .env.example .env')
    expect(printed).toContain('archive script (local):\n  (none)')
  })

  it('says an orca.yaml it could not read is unverifiable, not absent', async () => {
    queueFixtures(callMock, okFixture('req_repo_show', { repo: repoFixture() }))
    queueHooksRead(
      { hasHooksFile: false, hooks: null, source: null },
      { status: 'error', hasHooks: false, hooks: null }
    )
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['repo', 'hooks', 'show', '--repo', 'orca'], '/tmp/repo')

    expect(log.mock.calls.at(-1)?.[0]).toContain('orca.yaml: unverifiable')
  })

  it('shows the committed startup policy when the local settings do not set one', async () => {
    queueFixtures(callMock, okFixture('req_repo_show', { repo: repoFixture() }))
    queueHooksRead(
      {},
      { hooks: { scripts: { setup: 'pnpm install' }, setupAgentStartupPolicy: 'wait-for-setup' } }
    )
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['repo', 'hooks', 'show', '--repo', 'orca'], '/tmp/repo')

    expect(log.mock.calls.at(-1)?.[0]).toContain('setupAgentStartupPolicy: wait-for-setup')
  })

  it('names both command sources when setup and archive resolve differently', async () => {
    queueFixtures(
      callMock,
      okFixture('req_repo_show', {
        repo: repoFixture({
          hookSettings: { mode: 'auto', scripts: { setup: '', archive: 'echo bye' } }
        })
      })
    )
    queueHooksRead()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['repo', 'hooks', 'show', '--repo', 'orca'], '/tmp/repo')

    const printed = log.mock.calls.at(-1)?.[0]
    expect(printed).toContain('commandSource (setup): shared-only (resolved)')
    expect(printed).toContain('commandSource (archive): local-only (resolved)')
  })

  it('refuses to read both scripts from stdin, which would clear the second one', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'repo',
        'hooks',
        'set',
        '--repo',
        'orca',
        '--setup-script-file',
        '-',
        '--archive-script-file',
        '-',
        '--json'
      ],
      '/tmp'
    )

    expectRejection(log, 'Only one of --setup-script-file and --archive-script-file')
    expect(callMock).not.toHaveBeenCalled()
  })

  it('writes one script without dropping the other settings the repo already had', async () => {
    queueFixtures(
      callMock,
      okFixture('req_repo_show', {
        repo: repoFixture({
          hookSettings: {
            mode: 'override',
            setupRunPolicy: 'ask',
            commandSourcePolicy: 'local-only',
            scripts: { setup: 'old setup', archive: 'echo bye' }
          }
        })
      }),
      okFixture('req_repo_update', { repo: repoFixture() })
    )
    queueHooksRead()
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['repo', 'hooks', 'set', '--repo', 'orca', '--setup-script', 'pnpm install'],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenNthCalledWith(2, 'repo.update', {
      repo: 'orca',
      updates: {
        hookSettings: {
          mode: 'override',
          setupRunPolicy: 'ask',
          setupAgentStartupPolicy: 'start-immediately',
          commandSourcePolicy: 'local-only',
          scripts: { setup: 'pnpm install', archive: 'echo bye' }
        }
      }
    })
  })

  it('clears a local script when the value is null', async () => {
    queueFixtures(
      callMock,
      okFixture('req_repo_show', {
        repo: repoFixture({
          hookSettings: { mode: 'auto', scripts: { setup: 'pnpm install', archive: 'echo bye' } }
        })
      }),
      okFixture('req_repo_update', { repo: repoFixture() })
    )
    queueHooksRead()
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['repo', 'hooks', 'set', '--repo', 'orca', '--setup-script', 'null'], '/tmp/repo')

    expect(callMock).toHaveBeenNthCalledWith(
      2,
      'repo.update',
      expect.objectContaining({
        updates: {
          hookSettings: expect.objectContaining({
            scripts: { setup: '', archive: 'echo bye' }
          })
        }
      })
    )
  })

  it('reads a multi-line script from a file', async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = await mkdtemp(join(tmpdir(), 'orca-hooks-'))
    await writeFile(join(dir, 'setup.sh'), 'pnpm install\npnpm build\n', 'utf8')
    queueFixtures(
      callMock,
      okFixture('req_repo_show', { repo: repoFixture() }),
      okFixture('req_repo_update', { repo: repoFixture() })
    )
    queueHooksRead()
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['repo', 'hooks', 'set', '--repo', 'orca', '--setup-script-file', './setup.sh'], dir)

    expect(callMock).toHaveBeenNthCalledWith(
      2,
      'repo.update',
      expect.objectContaining({
        updates: {
          hookSettings: expect.objectContaining({
            scripts: { setup: 'pnpm install\npnpm build\n', archive: '' }
          })
        }
      })
    )
  })

  it('stores the setup policies', async () => {
    queueFixtures(
      callMock,
      okFixture('req_repo_show', { repo: repoFixture() }),
      okFixture('req_repo_update', { repo: repoFixture() })
    )
    queueHooksRead()
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'repo',
        'hooks',
        'set',
        '--repo',
        'orca',
        '--setup-run-policy',
        'skip-by-default',
        '--agent-startup',
        'wait-for-setup',
        '--command-source',
        'run-both'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenNthCalledWith(2, 'repo.update', {
      repo: 'orca',
      updates: {
        hookSettings: {
          mode: 'auto',
          setupRunPolicy: 'skip-by-default',
          setupAgentStartupPolicy: 'wait-for-setup',
          commandSourcePolicy: 'run-both',
          scripts: { setup: '', archive: '' }
        }
      }
    })
  })

  it('refuses a policy value it cannot store', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['repo', 'hooks', 'set', '--repo', 'orca', '--setup-run-policy', 'sometimes', '--json'],
      '/tmp'
    )

    expectRejection(log, '--setup-run-policy must be one of ask, run-by-default, skip-by-default')
    expect(callMock).not.toHaveBeenCalled()
  })

  it('refuses a set call that changes nothing', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['repo', 'hooks', 'set', '--repo', 'orca', '--json'], '/tmp')

    expectRejection(log, 'Nothing to change')
    expect(callMock).not.toHaveBeenCalled()
  })

  it('refuses both the inline script and the script file', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'repo',
        'hooks',
        'set',
        '--repo',
        'orca',
        '--setup-script',
        'pnpm install',
        '--setup-script-file',
        './setup.sh',
        '--json'
      ],
      '/tmp'
    )

    expectRejection(log, 'Use either --setup-script or --setup-script-file, not both')
  })

  it('says folder projects have no worktree hooks', async () => {
    queueFixtures(callMock, okFixture('req_repo_show', { repo: repoFixture({ kind: 'folder' }) }))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['repo', 'hooks', 'show', '--repo', 'notes', '--json'], '/tmp')

    expectRejection(log, 'Folder projects have no worktree hooks')
  })
})
