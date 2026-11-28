import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseArgs, validateCommandAndFlags } from '../arguments/args'
import { dispatch } from '../dispatch/dispatch'
import { RuntimeClient } from '../runtime/client'
import { CORE_COMMAND_SPECS } from '../specs/core'

describe('repo project group flags', () => {
  const client = new RuntimeClient('/tmp/orca-project-group-test', 60_000, null, null)
  const groups = [
    { id: 'group-work', name: 'Work', parentGroupId: null },
    { id: 'group-oss-a', name: 'OSS', parentGroupId: null },
    { id: 'group-oss-b', name: 'OSS', parentGroupId: 'group-work' }
  ]
  const repo = { id: 'repo-1', displayName: 'My repo', path: '/tmp/repo', connectionId: null }

  function run(args: string[]) {
    const parsed = parseArgs(['repo', ...args])
    validateCommandAndFlags(CORE_COMMAND_SPECS, parsed)
    return dispatch(parsed.commandPath, { flags: parsed.flags, client, cwd: '/tmp', json: true })
  }

  beforeEach(() => {
    vi.spyOn(client, 'call').mockImplementation(async (method: string) => ({
      id: method,
      ok: true as const,
      result: method === 'projectGroup.list' ? { groups } : { repo },
      _meta: { runtimeId: 'test-runtime' }
    }))
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each([
    { selector: 'group-oss-b', groupId: 'group-oss-b' },
    { selector: 'work', groupId: 'group-work' },
    { selector: 'none', groupId: null }
  ])('repo set moves the repo for --project-group $selector', async ({ selector, groupId }) => {
    await run(['set', '--repo', 'name:My repo', '--project-group', selector, '--json'])

    expect(client.call).toHaveBeenLastCalledWith('projectGroup.moveProject', {
      repo: 'name:My repo',
      groupId
    })
  })

  it('repo add registers the repo and then moves it into the group', async () => {
    await run(['add', '--path', '/tmp/repo', '--project-group', 'Work', '--json'])

    expect(client.call).toHaveBeenNthCalledWith(2, 'repo.add', { path: '/tmp/repo' })
    expect(client.call).toHaveBeenNthCalledWith(3, 'projectGroup.moveProject', {
      repo: 'id:repo-1',
      groupId: 'group-work',
      connectionId: null
    })
  })

  // The runtime ungroups a repo moved to an unknown group id, so bad selectors must stop first.
  it.each([
    {
      args: ['set', '--repo', 'id:repo-1', '--project-group', 'Missing'],
      message: 'No project group matches'
    },
    {
      args: ['set', '--repo', 'id:repo-1', '--project-group', 'OSS'],
      message: 'Ambiguous --project-group OSS'
    },
    {
      args: ['add', '--path', '/tmp/repo', '--project-group', 'Missing'],
      message: 'No project group matches'
    }
  ])('$args refuses before writing', async ({ args, message }) => {
    await expect(run(args)).rejects.toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining(message)
    })
    expect(client.call).toHaveBeenCalledExactlyOnceWith('projectGroup.list')
  })
})
