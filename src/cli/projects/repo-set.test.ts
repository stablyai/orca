import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeCommandPositionals, parseArgs } from '../arguments/args'
import type { HandlerContext } from '../dispatch/dispatch'
import type { RuntimeClient } from '../runtime/client'
import { COMMAND_SPECS } from '../specs'
import { REPO_HANDLERS } from './repo'

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

/** Parses argv the way the CLI does, then runs `repo set` against a host answering with `row`. */
async function repoSet(argv: string[], row: Record<string, unknown>) {
  const parsed = normalizeCommandPositionals(
    COMMAND_SPECS,
    parseArgs(
      ['repo', 'set', '--repo', 'name:web', ...argv],
      COMMAND_SPECS.map((spec) => spec.path),
      COMMAND_SPECS
    )
  )
  const call = vi.fn(async () => ({
    id: 'r',
    ok: true,
    result: { repo: { id: 'repo-1', ...row } },
    _meta: { runtimeId: 'rt' }
  }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: `repo set` only uses `call` for these flags.
  const client = { call } as unknown as RuntimeClient
  const context: HandlerContext = { client, cwd: '/', flags: parsed.flags, json: true, rawArgs: [] }
  await REPO_HANDLERS['repo set'](context)
  return call.mock.calls[0]
}

describe('repo set', () => {
  it('sends the agent startup policy and turns workspace cleanup off', async () => {
    const sent = await repoSet(
      ['--setup-agent-startup', 'wait-for-setup', '--workspace-cleanup', 'off'],
      {
        hookSettings: { setupAgentStartupPolicy: 'wait-for-setup' },
        workspaceCleanupPolicy: { mode: 'off' }
      }
    )
    expect(sent).toEqual([
      'repo.update',
      {
        repo: 'name:web',
        updates: {
          setupAgentStartupPolicy: 'wait-for-setup',
          workspaceCleanupPolicy: { mode: 'off' }
        }
      }
    ])
  })

  it('clears the cleanup override with inherit', async () => {
    const sent = await repoSet(['--workspace-cleanup', 'inherit'], {})
    expect(sent).toEqual([
      'repo.update',
      { repo: 'name:web', updates: { workspaceCleanupPolicy: null } }
    ])
  })

  it('fails when an older host drops the new fields', async () => {
    await expect(
      repoSet(
        [
          '--external-worktree-visibility',
          'show',
          '--setup-agent-startup',
          'wait-for-setup',
          '--workspace-cleanup',
          'off'
        ],
        { externalWorktreeVisibility: 'show', hookSettings: { mode: 'auto' } }
      )
    ).rejects.toMatchObject({
      code: 'incompatible_runtime',
      message:
        'This Orca host does not support per-repo agent startup policies and per-repo workspace cleanup, so only the worktree visibility was saved. Update Orca on that host.'
    })
  })

  it('rejects an empty value instead of saving the other settings', async () => {
    await expect(
      repoSet(['--setup-agent-startup=', '--workspace-cleanup', 'off'], {})
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: '--setup-agent-startup must be wait-for-setup or start-immediately.'
    })
  })
})
