import { EVERY_AGENT_CHAT } from '../../shared/native-chat/every-agent-chat.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import type { CreateWorktreeResult } from '../../shared/worktree/create-types'
import type { RuntimeManagedWorktreeCreateArgs } from '../runtime/runtime-managed-worktree-create-types'
import { createWorktreeWithStartupAgent } from './startup-agent-worktree-create'

const CHAT_DEFAULT_ON = { nativeChatProviders: EVERY_AGENT_CHAT }

function harness(
  options: {
    created?: Partial<CreateWorktreeResult>
    draftAgent?: string | null
    createError?: Error
  } = {}
) {
  const created = {
    worktree: { id: 'repo-1::/wt/new' },
    startupTerminal: {
      spawned: true,
      handle: 'term_agent',
      paneKey: 'tab-1:leaf-1'
    },
    ...options.created
  }
  const runtime = {
    requireStore: () => ({ getSettings: () => CHAT_DEFAULT_ON }),
    getStructuredAgentSessionCreateSupport: vi.fn(async () => ({
      supported: true
    })),
    showRepo: vi.fn(async () => ({ id: 'repo-1', connectionId: null, executionHostId: null })),
    resolveStartupDraftAgent: vi.fn(async () =>
      options.draftAgent === undefined ? 'claude' : options.draftAgent
    ),
    createManagedWorktree: vi.fn(async (_args: RuntimeManagedWorktreeCreateArgs) => {
      if (options.createError) {
        throw options.createError
      }
      return created
    })
  }
  return {
    runtime,
    created,
    create: (args: RuntimeManagedWorktreeCreateArgs) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture implements every runtime method the entry and the executor reach.
      createWorktreeWithStartupAgent(runtime as never, args)
  }
}

const BASE: RuntimeManagedWorktreeCreateArgs = {
  repoSelector: 'repo-1',
  name: 'feature',
  activate: false,
  setupDecision: 'skip',
  lineage: { noParent: true }
}

describe('createWorktreeWithStartupAgent', () => {
  it('builds no second agent when the create spawned none here', async () => {
    const { runtime, created, create } = harness({
      created: {
        startupTerminal: undefined,
        warning: 'Failed to create the startup terminal for /wt/new: spawn failed'
      }
    })

    const result = await create({
      ...BASE,
      startupAgent: 'claude',
      startupPrompt: 'hi'
    })

    expect(result).toBe(created)
    expect(runtime.createManagedWorktree).toHaveBeenCalledTimes(1)
  })
})
