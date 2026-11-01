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

const FULL: RuntimeManagedWorktreeCreateArgs = {
  ...BASE,
  navigation: 'caller',
  createdWithAgent: 'claude',
  startupLaunchPreferences: { model: 'opus', effort: 'high' },
  startupAgentArgs: '--verbose',
  startupExtraAgentArgs: '--extra',
  startupCwd: 'packages/app',
  startupPaneKey: 'tab-1:leaf-1',
  pendingFirstAgentMessageRename: true,
  automationProvenance: {
    kind: 'created-by-automation',
    automationId: 'auto-1',
    automationNameSnapshot: 'Nightly',
    automationRunId: 'run-1',
    automationRunTitleSnapshot: 'Nightly run',
    createdAt: 1,
    executionTargetType: 'local',
    executionTargetId: 'local',
    projectId: 'project-1'
  },
  cliProvenance: { kind: 'created-by-cli', createdAt: 1, startupAgent: 'claude' },
  lineage: { parentWorktree: 'id:parent', callerTerminalHandle: 'term_parent' },
  comment: 'from the CLI',
  linkedIssue: 7
}

describe('createWorktreeWithStartupAgent', () => {
  it('forwards the startup agent and prompt to the create with the chat default on', async () => {
    const { runtime, created, create } = harness()
    const prompt = 'x'.repeat(3000)
    const args = {
      ...FULL,
      startupAgent: 'claude' as const,
      startupPrompt: prompt,
      startupLaunchSource: 'cli'
    }

    const result = await create(args)

    expect(result).toBe(created)
    expect(runtime.createManagedWorktree).toHaveBeenCalledTimes(1)
    expect(runtime.createManagedWorktree).toHaveBeenCalledWith(args)
    expect(runtime.getStructuredAgentSessionCreateSupport).not.toHaveBeenCalled()
  })

  it('forwards a post-start agent and prompt to the create', async () => {
    const { runtime, create } = harness()
    const args = { ...FULL, startupAgent: 'aider' as const, startupPrompt: 'fix the bug' }

    await create(args)

    expect(runtime.createManagedWorktree).toHaveBeenCalledWith(args)
  })

  it('omits a blank startup prompt from the create request', async () => {
    for (const startupPrompt of ['', '  \n']) {
      const { runtime, create } = harness()

      await create({ ...FULL, startupAgent: 'codex', startupPrompt })

      expect(runtime.createManagedWorktree).toHaveBeenCalledWith({ ...FULL, startupAgent: 'codex' })
    }
  })

  it('forwards a linked draft through `startupDraft` with its resolved agent', async () => {
    const { runtime, create } = harness({ draftAgent: 'codex' })
    const { createdWithAgent: _requested, ...request } = FULL
    const draft = 'https://github.com/o/r/issues/1'

    await create({ ...request, startupDraft: draft })

    expect(runtime.resolveStartupDraftAgent).toHaveBeenCalledWith(
      { id: 'repo-1', connectionId: null, executionHostId: null },
      undefined
    )
    expect(runtime.createManagedWorktree).toHaveBeenCalledWith({
      ...request,
      startupDraft: draft,
      startupDraftAgent: 'codex'
    })
  })

  it('asks for the requested draft agent and keeps it as the request named it', async () => {
    const { runtime, create } = harness()

    await create({ ...FULL, startupDraft: 'https://x/1' })

    expect(runtime.resolveStartupDraftAgent).toHaveBeenCalledWith(expect.anything(), 'claude')
    expect(runtime.createManagedWorktree).toHaveBeenCalledWith({
      ...FULL,
      startupDraft: 'https://x/1',
      startupDraftAgent: 'claude'
    })
  })

  it('creates without the draft when it resolves no agent, so the create does not detect again', async () => {
    const { runtime, create } = harness({ draftAgent: null })

    await create({ ...FULL, startupDraft: 'https://x/1' })

    expect(runtime.resolveStartupDraftAgent).toHaveBeenCalledTimes(1)
    expect(runtime.createManagedWorktree).toHaveBeenCalledWith(FULL)
  })

  it('passes a request with no agent, a blank draft, or a prebuilt command straight to the create', async () => {
    for (const args of [
      BASE,
      { ...BASE, startupDraft: '   ' },
      {
        ...BASE,
        startupAgent: 'claude' as const,
        startup: { command: 'claude' }
      }
    ]) {
      const { runtime, create } = harness()
      await create(args)
      expect(runtime.createManagedWorktree).toHaveBeenCalledWith(args)
      expect(runtime.showRepo).not.toHaveBeenCalled()
    }
  })

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

  it('surfaces a create failure unchanged', async () => {
    const failure = new Error(
      'Selected agent is disabled. Choose an enabled agent before creating.'
    )
    const { create } = harness({ createError: failure })

    await expect(create({ ...BASE, startupAgent: 'claude' })).rejects.toBe(failure)
  })
})
