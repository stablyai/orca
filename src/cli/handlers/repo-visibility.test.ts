import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import { parseArgs, validateCommandAndFlags } from '../args'
import { dispatch } from '../dispatch'
import { RuntimeClient } from '../runtime-client'
import { CORE_COMMAND_SPECS } from '../specs/core'

describe('repo set worktree visibility', () => {
  const client = new RuntimeClient('/tmp/orca-visibility-test', 60_000, null, null)
  const reply = {
    id: 'repo-update',
    ok: true as const,
    result: { repo: { id: 'repo-1', displayName: 'My repo', path: '/tmp/repo' } },
    _meta: { runtimeId: 'test-runtime' }
  }

  function run(args: string[]) {
    const parsed = parseArgs(['repo', 'set', ...args])
    validateCommandAndFlags(CORE_COMMAND_SPECS, parsed)
    return dispatch(parsed.commandPath, {
      flags: parsed.flags,
      client,
      cwd: '/tmp/another-repo',
      json: true
    })
  }

  beforeEach(() => {
    vi.spyOn(client, 'call').mockResolvedValue(reply)
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each([
    { visibility: 'show', stored: 'show', repo: 'id:repo-1' },
    { visibility: 'hide', stored: 'hide', repo: 'name:Repo with spaces' },
    { visibility: 'inherit', stored: null, repo: String.raw`path:C:\Repos\My repo` },
    { visibility: 'show', stored: 'show', repo: 'path:/tmp/My repo' }
  ])(
    'sets $visibility for $repo without changing other fields',
    async ({ visibility, stored, repo }) => {
      await run(['--repo', repo, '--external-worktree-visibility', visibility, '--json'])

      expect(client.call).toHaveBeenCalledExactlyOnceWith('repo.update', {
        repo,
        updates: { externalWorktreeVisibility: stored }
      })
      expect(console.log).toHaveBeenCalledExactlyOnceWith(JSON.stringify(reply, null, 2))
    }
  )

  it.each([
    { args: ['--repo', 'id:repo-1'], message: 'Missing required --external-worktree-visibility' },
    {
      args: ['--repo', 'id:repo-1', '--external-worktree-visibility'],
      message: '--external-worktree-visibility requires a value'
    },
    {
      args: ['--repo', 'id:repo-1', '--external-worktree-visibility='],
      message: 'Missing required --external-worktree-visibility'
    },
    { args: ['--external-worktree-visibility', 'show'], message: 'Missing required --repo' },
    {
      args: ['--repo', 'id:repo-1', '--external-worktree-visibility', 'visible'],
      message: '--external-worktree-visibility must be show, hide, or inherit.'
    },
    { args: ['--repo', 'id:repo-1', '--force'], message: 'Missing required' },
    {
      args: ['--repo', 'id:repo-1', '--external-worktree-visibility', 'show', '--force'],
      message: '--force only applies with --path.'
    }
  ])('rejects $args before calling the runtime', async ({ args, message }) => {
    await expect(run(args)).rejects.toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining(message)
    })
    expect(client.call).not.toHaveBeenCalled()
  })
})

describe('repo set --path', () => {
  const client = new RuntimeClient('/tmp/orca-relink-test', 60_000, null, null)
  const reply = {
    id: 'repo-update',
    ok: true as const,
    result: { repo: { id: 'repo-1', displayName: 'My repo', path: '/moved/repo' } },
    _meta: { runtimeId: 'test-runtime' }
  }

  function run(args: string[]) {
    const parsed = parseArgs(['repo', 'set', ...args])
    validateCommandAndFlags(CORE_COMMAND_SPECS, parsed)
    return dispatch(parsed.commandPath, {
      flags: parsed.flags,
      client,
      cwd: '/tmp/cwd',
      json: true
    })
  }

  beforeEach(() => {
    vi.spyOn(client, 'call').mockResolvedValue(reply)
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('relinks with a path resolved against the CLI cwd', async () => {
    await run(['--repo', 'id:repo-1', '--path', 'moved/repo', '--json'])
    expect(client.call).toHaveBeenCalledExactlyOnceWith('repo.update', {
      repo: 'id:repo-1',
      updates: { path: resolve('/tmp/cwd', 'moved/repo') }
    })
  })

  it('forwards --force and combines with a visibility change', async () => {
    await run([
      '--repo',
      'id:repo-1',
      '--path',
      '/moved/repo',
      '--force',
      '--external-worktree-visibility',
      'hide',
      '--json'
    ])
    expect(client.call).toHaveBeenCalledExactlyOnceWith('repo.update', {
      repo: 'id:repo-1',
      updates: { externalWorktreeVisibility: 'hide', path: '/moved/repo' },
      forcePath: true
    })
  })
})
