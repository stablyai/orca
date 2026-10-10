/**
 * Recorded `worktree.create` requests from clients that update separately from the host: the CLI's
 * `worktree create --agent --prompt` and the phone's create-from-issue draft. The host now starts
 * their agent through the launch executor; what they send and read must not change.
 */

import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { WORKTREE_METHODS } from './worktree'

const repo = {
  id: 'repo-1',
  path: '/workspace/repo',
  displayName: 'repo',
  badgeColor: '#000',
  addedAt: 1,
  kind: 'git' as const
}

// `orca worktree create --name agent-task --agent claude --prompt "fix the login bug" --json`
const CLI_AGENT_CREATE = {
  repo: 'id:repo-1',
  name: 'agent-task',
  displayName: 'agent-task',
  displayNameKind: 'user',
  runHooks: false,
  activate: false,
  noParent: false,
  cliProvenanceRequest: {},
  startupAgent: 'claude',
  startupPrompt: 'fix the login bug',
  launchSource: 'cli'
}

// The phone's "create workspace from issue" with an agent picked.
const PHONE_ISSUE_DRAFT_CREATE = {
  repo: 'id:repo-1',
  name: 'issue-88',
  displayName: 'Investigate login',
  displayNameKind: 'generated',
  setupDecision: 'skip',
  activate: true,
  startupDraft: 'https://github.com/acme/app/issues/88',
  createdWithAgent: 'codex',
  linkedIssue: 88,
  clientMutationId: 'mobile-mutation-1'
}

function harness(created: Record<string, unknown>) {
  const createManagedWorktree = vi.fn().mockResolvedValue(created)
  const resolveStartupDraftAgent = vi.fn(async (_repo: unknown, requested?: string) => requested)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture implements every runtime method worktree.create reaches for a create with no automation provenance.
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    dedupeWorktreeCreate: <T>(_repo: string, _id: string | undefined, run: () => Promise<T>) =>
      run(),
    showRepo: vi.fn().mockResolvedValue(repo),
    // The chat default is on: `worktree.create` still answers with a terminal agent.
    getClientSettings: () => ({ experimentalNativeChat: true }),
    getStructuredAgentSessionCreateSupport: vi.fn(async () => ({
      supported: true
    })),
    resolveStartupDraftAgent,
    createManagedWorktree
  } as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime, methods: WORKTREE_METHODS })
  const dispatch = (params: Record<string, unknown>) =>
    dispatcher.dispatch({
      id: 'req-1',
      authToken: 'tok',
      method: 'worktree.create',
      params
    })
  return { dispatch, createManagedWorktree, runtime }
}

describe('worktree.create with a startup agent', () => {
  it("answers the CLI's agent create with the same terminal handle, the prompt folded by the create", async () => {
    const { dispatch, createManagedWorktree, runtime } = harness({
      worktree: { id: 'repo-1::/wt/agent-task' },
      startupTerminal: {
        spawned: true,
        handle: 'term_agent',
        surface: 'background'
      }
    })

    const response = await dispatch(CLI_AGENT_CREATE)

    expect(response).toMatchObject({
      ok: true,
      result: {
        worktree: { id: 'repo-1::/wt/agent-task' },
        startupTerminal: { handle: 'term_agent' },
        agentTerminalHandle: 'term_agent'
      }
    })
    expect(createManagedWorktree).toHaveBeenCalledTimes(1)
    const args = createManagedWorktree.mock.calls[0][0]
    expect(args).toMatchObject({
      startupAgent: 'claude',
      startupPrompt: 'fix the login bug',
      startupLaunchSource: 'cli',
      activate: false
    })
    expect(args).not.toHaveProperty('onStartupPromptCarry')
    expect(args).not.toHaveProperty('awaitTerminalProvisioning')
    expect(runtime.getStructuredAgentSessionCreateSupport).not.toHaveBeenCalled()
  })

  it("leaves the phone's issue URL as an unsent draft and returns no agent handle, as before", async () => {
    const { dispatch, createManagedWorktree } = harness({
      worktree: { id: 'repo-1::/wt/issue-88' },
      startupTerminal: {
        spawned: true,
        handle: 'term_draft',
        surface: 'background'
      }
    })

    const response = await dispatch(PHONE_ISSUE_DRAFT_CREATE)

    expect(response).toMatchObject({
      ok: true,
      result: { worktree: { id: 'repo-1::/wt/issue-88' } }
    })
    expect(response).not.toHaveProperty('result.agentTerminalHandle')
    const args = createManagedWorktree.mock.calls[0][0]
    expect(args).toMatchObject({
      startupDraft: 'https://github.com/acme/app/issues/88',
      createdWithAgent: 'codex',
      linkedIssue: 88,
      activate: true
    })
    expect(args).not.toHaveProperty('startupAgent')
    expect(args).not.toHaveProperty('startupPrompt')
  })

  it('answers without an agent handle when the create started no agent here', async () => {
    const { dispatch, createManagedWorktree } = harness({
      worktree: { id: 'repo-1::/wt/agent-task' },
      warning: 'Failed to create the startup terminal for /wt/agent-task: spawn failed'
    })

    const response = await dispatch(CLI_AGENT_CREATE)

    expect(response).toMatchObject({
      ok: true,
      result: {
        warning: 'Failed to create the startup terminal for /wt/agent-task: spawn failed'
      }
    })
    expect(response).not.toHaveProperty('result.agentTerminalHandle')
    expect(createManagedWorktree).toHaveBeenCalledTimes(1)
  })
})
