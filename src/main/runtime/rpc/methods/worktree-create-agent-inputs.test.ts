import { expect, it } from 'vitest'
import { WorktreeCreate } from '../../../../shared/rpc-contract/worktree-create-params'
import { buildManagedWorktreeCreateArgs } from './worktree-create-args'
import { resolveManagedWorktreeCreateStartup } from '../../workspaces/startup/managed-worktree-create-startup'

it('keeps picks and authored empty Arguments across the worktree.create boundary', () => {
  const args = buildManagedWorktreeCreateArgs(
    WorktreeCreate.parse({
      repo: 'repo',
      startupAgent: 'claude',
      startupAgentArgs: '',
      startupSessionOptions: { model: 'opus', effort: 'high', permissionMode: 'full-access' },
      startupLaunchPreferences: { model: 'opus', effort: 'high', mode: 'full-access' }
    }),
    {}
  )
  expect(args).toMatchObject({
    startupAgent: 'claude',
    startupAgentArgs: '',
    startupSessionOptions: { model: 'opus', effort: 'high', permissionMode: 'full-access' },
    startupLaunchPreferences: { model: 'opus', effort: 'high', mode: 'full-access' }
  })
})

it('passes draft inputs to the host builder without refusing a disabled requested agent', async () => {
  const args = buildManagedWorktreeCreateArgs(
    WorktreeCreate.parse({
      repo: 'repo',
      createdWithAgent: 'claude',
      startupDraft: 'ship it',
      startupAgentArgs: null,
      startupSessionOptions: { model: 'opus' }
    }),
    {}
  )
  const result = await resolveManagedWorktreeCreateStartup(args, ['claude'], {
    agent: () => {
      throw new Error('ordinary-agent path reached')
    },
    draft: async (draft, agent, _source, inputs) => {
      expect({
        draft,
        agent,
        args: inputs?.startupAgentArgs,
        options: inputs?.startupSessionOptions
      }).toEqual({ draft: 'ship it', agent: 'claude', args: null, options: { model: 'opus' } })
      return {
        agent: 'codex',
        startup: {
          command: 'codex',
          telemetry: { agent_kind: 'codex', launch_source: 'unknown', request_kind: 'new' }
        },
        draftPaste: { agent: 'codex', content: draft },
        launchRuntime: new Error('fixture')
      }
    }
  })
  expect(result.effectiveCreatedWithAgent).toBe('codex')
  expect(result.effectiveDraftPaste).toEqual({ agent: 'codex', content: 'ship it' })
})
