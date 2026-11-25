import { afterEach, describe, expect, it, vi } from 'vitest'
import { COMMAND_SPECS } from '../specs/index'
import { normalizeCommandPositionals, parseArgs } from '../arguments/args'
import { specPaths } from '../discovery/command-spec'
import type { HandlerContext } from '../dispatch/dispatch'
import type { RuntimeClient } from '../runtime/client'
import { RuntimeClientError } from '../runtime/connection/types'
import { GROUP_HANDLERS } from './group'

const group = (id: string, name: string, parentGroupId: string | null = null) => ({
  id,
  name,
  parentGroupId
})

const GROUPS = [
  group('g-clients', 'Clients'),
  group('g-acme', 'Acme', 'g-clients'),
  group('g-twin-a', 'Twin'),
  group('g-twin-b', 'Twin', 'g-clients')
]

afterEach(() => {
  vi.restoreAllMocks()
})

/** Runs one `group` command against canned reads; reports its refusal and every write it attempted. */
async function run(
  argv: string[],
  writes: Record<string, unknown> = {}
): Promise<{ attempted: [method: string, params: unknown][]; refusal: unknown }> {
  const paths = COMMAND_SPECS.flatMap((spec) => specPaths(spec))
  const parsed = normalizeCommandPositionals(COMMAND_SPECS, parseArgs(argv, paths, COMMAND_SPECS))
  const attempted: [string, unknown][] = []
  const reads: Record<string, unknown> = {
    'projectGroup.list': { groups: GROUPS },
    'repo.list': { repos: [{ id: 'r1', projectGroupId: 'g-acme' }] },
    'folderWorkspace.list': { folderWorkspaces: [] }
  }
  const call = vi.fn(async (method: string, params?: unknown) => {
    if (method in reads) {
      return { result: reads[method] }
    }
    attempted.push([method, params])
    const reply = writes[method]
    if (reply instanceof Error) {
      throw reply
    }
    return { result: reply }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: group handlers only use client.call.
  const client = { call, isRemote: false } as unknown as RuntimeClient
  const ctx: HandlerContext = { flags: parsed.flags, client, cwd: '/', json: true, rawArgs: argv }
  vi.spyOn(console, 'log').mockReturnValue(undefined)
  const refusal = await GROUP_HANDLERS[argv.slice(0, 2).join(' ')](ctx).then(
    () => null,
    (error: unknown) => error
  )
  return { attempted, refusal }
}

describe('group commands', () => {
  it('removes a group holding projects only with --force', async () => {
    expect(await run(['group', 'rm', '--group', 'name:Clients'])).toMatchObject({
      refusal: { code: 'group_not_empty' },
      attempted: []
    })
    expect(
      await run(['group', 'rm', '--group', 'name:Clients', '--force'], {
        'projectGroup.delete': { deleted: true }
      })
    ).toEqual({ refusal: null, attempted: [['projectGroup.delete', { groupId: 'g-clients' }]] })
  })

  it('never picks between groups that share a name', async () => {
    expect(await run(['group', 'rm', '--group', 'Twin'])).toMatchObject({
      refusal: { code: 'selector_ambiguous' },
      attempted: []
    })
  })

  it('refuses to nest a group inside its own subtree', async () => {
    expect(
      await run(['group', 'set', '--group', 'id:g-clients', '--parent', 'name:Acme'])
    ).toMatchObject({ refusal: { code: 'invalid_argument' }, attempted: [] })
  })

  it('saves nothing when the host cannot re-parent', async () => {
    expect(
      await run(['group', 'set', '--group', 'name:Acme', '--parent', 'none', '--name', 'Renamed'], {
        'projectGroup.setParent': new RuntimeClientError('method_not_found', 'Unknown method')
      })
    ).toMatchObject({
      refusal: { code: 'incompatible_runtime' },
      attempted: [['projectGroup.setParent', { groupId: 'g-acme', parentGroupId: null }]]
    })
  })
})
