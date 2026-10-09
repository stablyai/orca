import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseArgs, validateCommandAndFlags } from '../args'
import { dispatch } from '../dispatch'
import { RuntimeClient } from '../runtime-client'
import { CORE_COMMAND_SPECS } from '../specs/core'
import { MAX_REPO_TERMINAL_THEME_SELECTION_LENGTH } from '../../shared/repo-terminal-theme'

describe('repo set-theme', () => {
  const client = new RuntimeClient('/tmp/orca-theme-test', 60_000, null, null)
  const reply = (terminalTheme: unknown, executionHostId = 'local') => ({
    id: 'theme-test',
    ok: true as const,
    result: {
      repo: { id: 'repo-1', path: '/tmp/repo', displayName: 'Repo', executionHostId, terminalTheme }
    },
    _meta: { runtimeId: 'test-runtime' }
  })
  function run(args: string[]) {
    const parsed = parseArgs(['repo', 'set-theme', ...args])
    validateCommandAndFlags(CORE_COMMAND_SPECS, parsed)
    return dispatch(parsed.commandPath, { flags: parsed.flags, client, cwd: '/tmp', json: true })
  }
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it.each([
    {
      mode: 'dark',
      theme: ' Dracula ',
      before: { light: 'Builtin Tango Light' },
      after: { dark: 'Dracula', light: 'Builtin Tango Light' },
      repo: 'name:Repo with spaces',
      host: 'local'
    },
    {
      mode: 'light',
      theme: 'custom:warp:quiet-light',
      before: { dark: 'Dracula' },
      after: { dark: 'Dracula', light: 'custom:warp:quiet-light' },
      repo: String.raw`path:C:\Repos\Repo`,
      host: 'local'
    },
    {
      mode: 'dark',
      theme: 'inherit',
      before: { dark: 'Dracula', light: 'Builtin Tango Light' },
      after: { light: 'Builtin Tango Light' },
      repo: 'id:repo-1',
      host: 'ssh:server'
    },
    {
      mode: 'light',
      theme: 'inherit',
      before: { light: 'Builtin Tango Light' },
      after: null,
      repo: 'id:repo-1',
      host: 'local'
    }
  ])(
    'sets $mode to $theme and preserves the other mode',
    async ({ mode, theme, before, after, repo, host }) => {
      vi.spyOn(client, 'call')
        .mockResolvedValueOnce(reply(before, host))
        .mockResolvedValueOnce(reply(after, host))
      await run(['--repo', repo, '--mode', mode, '--theme', theme])
      expect(client.call).toHaveBeenNthCalledWith(1, 'repo.show', { repo })
      expect(client.call).toHaveBeenNthCalledWith(2, 'repo.update', {
        repo,
        updates: { terminalTheme: after }
      })
      expect(console.log).toHaveBeenCalledExactlyOnceWith(
        JSON.stringify(reply(after, host), null, 2)
      )
    }
  )

  it.each([
    ['--repo', 'id:repo-1', '--mode', 'dim', '--theme', 'Dracula'],
    ['--repo', 'id:repo-1', '--mode', 'dark'],
    ['--repo', 'id:repo-1', '--mode', 'dark', '--theme'],
    ['--repo', 'id:repo-1', '--mode', 'dark', '--theme', '   '],
    [
      '--repo',
      'id:repo-1',
      '--mode',
      'dark',
      '--theme',
      'x'.repeat(MAX_REPO_TERMINAL_THEME_SELECTION_LENGTH + 1)
    ],
    ['--mode', 'dark', '--theme', 'Dracula']
  ])('rejects invalid arguments before contacting the runtime (%j)', async (...args) => {
    vi.spyOn(client, 'call')
    await expect(run(args)).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(client.call).not.toHaveBeenCalled()
  })

  it('rejects paired-runtime rows without writing', async () => {
    vi.spyOn(client, 'call').mockResolvedValueOnce(reply(undefined, 'runtime:server'))
    await expect(
      run(['--repo', 'id:repo-1', '--mode', 'dark', '--theme', 'Dracula'])
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(client.call).toHaveBeenCalledTimes(1)
  })

  it('reports an older runtime silently dropping the update', async () => {
    vi.spyOn(client, 'call').mockResolvedValue(reply(undefined))
    await expect(
      run(['--repo', 'id:repo-1', '--mode', 'dark', '--theme', 'Dracula'])
    ).rejects.toMatchObject({ code: 'unsupported_operation' })
    expect(console.log).not.toHaveBeenCalled()
  })

  it('propagates runtime write failures', async () => {
    vi.spyOn(client, 'call')
      .mockResolvedValueOnce(reply(undefined))
      .mockRejectedValueOnce(new Error('disconnected'))
    await expect(
      run(['--repo', 'id:repo-1', '--mode', 'dark', '--theme', 'Dracula'])
    ).rejects.toThrow('disconnected')
    expect(console.log).not.toHaveBeenCalled()
  })
})
