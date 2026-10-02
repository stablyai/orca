import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseArgs, validateCommandAndFlags } from '../args'
import { COMMAND_SPECS } from '../specs'
import { dispatch } from '../dispatch'
import { RuntimeClient } from '../runtime-client'

/** Exercises the real parser and dispatcher without contacting an installed Orca runtime. */
function createCommand() {
  const client = new RuntimeClient(join(tmpdir(), 'orca-visibility-cli-test'), 1000, null, null)
  const call = vi.spyOn(client, 'call').mockResolvedValue({
    id: 'visibility-test',
    ok: true,
    _meta: { runtimeId: 'visibility-runtime' },
    result: { repo: { id: 'repo-1', externalWorktreeVisibility: 'show' } }
  })
  const output = vi.spyOn(console, 'log').mockImplementation(() => {})
  const run = async (args: string[]) => {
    const parsed = parseArgs(['repo', 'set-worktree-visibility', ...args])
    validateCommandAndFlags(COMMAND_SPECS, parsed)
    await dispatch(parsed.commandPath, {
      flags: parsed.flags,
      client,
      cwd: tmpdir(),
      json: parsed.flags.get('json') === true
    })
  }
  return { call, output, run }
}

afterEach(() => vi.restoreAllMocks())

describe('repo set-worktree-visibility', () => {
  it.each([
    ['show', 'show'],
    ['hide', 'hide'],
    ['inherit', null]
  ] as const)('sets %s through the existing repo update contract', async (value, expected) => {
    const { call, output, run } = createCommand()
    await run(['--repo', 'id:repo-1', '--external', value, '--json'])
    expect(call).toHaveBeenCalledExactlyOnceWith('repo.update', {
      repo: 'id:repo-1',
      updates: { externalWorktreeVisibility: expected }
    })
    expect(output).toHaveBeenCalledWith(expect.stringContaining('"repo"'))
  })

  it('forwards the repo selector verbatim, independent of the runtime transport', async () => {
    const { call, run } = createCommand()
    await run(['--repo', 'path:/srv/project', '--external', 'show'])
    expect(call).toHaveBeenCalledExactlyOnceWith('repo.update', {
      repo: 'path:/srv/project',
      updates: { externalWorktreeVisibility: 'show' }
    })
  })

  it.each([
    { flags: [] },
    { flags: ['--external'] },
    { flags: ['--external', ''] },
    { flags: ['--external', 'visible'] }
  ])('rejects missing or invalid values before mutation: %j', async ({ flags }) => {
    const { call, run } = createCommand()
    await expect(run(['--repo', 'id:repo-1', ...flags])).rejects.toMatchObject({
      code: 'invalid_argument'
    })
    expect(call).not.toHaveBeenCalled()
  })

  it('requires a repo selector before mutation', async () => {
    const { call, run } = createCommand()
    await expect(run(['--external', 'show'])).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(call).not.toHaveBeenCalled()
  })

  it('reports a repo that disappeared instead of printing a successful update', async () => {
    const { call, output, run } = createCommand()
    const error = new Error('repo_not_found')
    call.mockRejectedValueOnce(error)
    await expect(run(['--repo', 'id:repo-1', '--external', 'show'])).rejects.toBe(error)
    expect(output).not.toHaveBeenCalled()
  })

  it('propagates runtime errors', async () => {
    const { call, run } = createCommand()
    const error = new Error('Remote runtime unavailable')
    call.mockRejectedValueOnce(error)
    await expect(run(['--repo', 'id:repo-1', '--external', 'hide'])).rejects.toBe(error)
  })
})
