import { describe, expect, it } from 'vitest'
import {
  agentLaunchCreateParams,
  agentLaunchExistingParams,
  isAgentLaunchUnsupportedRefusal,
  readAgentLaunchCreateOutcome
} from './agent-launch-request'

describe('agentLaunchCreateParams', () => {
  it('carries the create payload verbatim minus the reserved agent fields', () => {
    // Strip startupAgent: it forces agent-first PTY creation and bypasses the host’s surface choice.
    expect(
      agentLaunchCreateParams('codex', {
        repo: 'id:repo-1',
        name: 'otter',
        setupDecision: 'run',
        comment: 'spike',
        clientMutationId: 'k-1',
        startupAgent: 'codex',
        startupDraft: 'https://example.test/issues/1',
        createdWithAgent: 'codex'
      })
    ).toEqual({
      agent: 'codex',
      target: {
        kind: 'create-worktree',
        create: {
          repo: 'id:repo-1',
          name: 'otter',
          setupDecision: 'run',
          comment: 'spike',
          clientMutationId: 'k-1',
          createdWithAgent: 'codex'
        }
      }
    })
  })
})

describe('agentLaunchExistingParams', () => {
  const launch = { agent: 'codex', worktreeId: 'wt-1', operationId: 'op-1' } as const

  it("sends an action's model and effort as session options", () => {
    expect(
      agentLaunchExistingParams({
        ...launch,
        sessionOptions: { model: 'gpt-5.6-terra', effort: 'high' }
      }).sessionOptions
    ).toEqual({ model: 'gpt-5.6-terra', effort: 'high' })
  })

  it('omits session options when the action saved no model', () => {
    expect(agentLaunchExistingParams(launch)).not.toHaveProperty('sessionOptions')
  })
})

describe('readAgentLaunchCreateOutcome', () => {
  it.each([
    {
      label: 'structured',
      result: {
        worktreeId: 'wt-1',
        outcome: { kind: 'structured', sessionId: 's-1', handle: 'agent-session:s-1' }
      }
    },
    {
      label: 'terminal',
      result: { worktreeId: 'wt-1', outcome: { kind: 'terminal', handle: 'term-1' } }
    }
  ])('reads the created workspace out of a $label receipt', ({ result }) => {
    expect(readAgentLaunchCreateOutcome(result)).toEqual({ worktreeId: 'wt-1' })
  })

  it.each([null, 'wt-1', {}, { worktreeId: '' }, { worktreeId: 7 }])(
    'refuses a receipt with no workspace (%j)',
    (result) => {
      expect(readAgentLaunchCreateOutcome(result)).toBeNull()
    }
  )

  it('carries the launch warning, so a workspace that is incomplete says why', () => {
    // A seated workspace may still be incomplete; retain the host’s top-level failure reason.
    expect(
      readAgentLaunchCreateOutcome({
        worktreeId: 'wt-1',
        outcome: { kind: 'structured', sessionId: 's-1', handle: 'agent-session:s-1' },
        warning: 'No pty available'
      })
    ).toEqual({ worktreeId: 'wt-1', warning: 'No pty available' })
  })

  it.each([
    { label: 'blank', warning: '   ' },
    { label: 'absent', warning: undefined },
    { label: 'non-string', warning: 7 }
  ])('reports no warning when it is $label', ({ warning }) => {
    expect(
      readAgentLaunchCreateOutcome({
        worktreeId: 'wt-1',
        outcome: { kind: 'terminal', handle: 'term-1' },
        warning
      })
    ).toEqual({ worktreeId: 'wt-1' })
  })

  it('ignores a warning outside the v2 top-level result contract', () => {
    expect(
      readAgentLaunchCreateOutcome({
        worktreeId: 'wt-1',
        outcome: { kind: 'terminal', handle: 'term-1', warning: 'stale nested warning' }
      })
    ).toEqual({ worktreeId: 'wt-1' })
  })
})

describe('isAgentLaunchUnsupportedRefusal', () => {
  it.each([
    { code: 'method_not_found', message: 'Unknown method: agent.launch' },
    { code: 'forbidden', message: "Method 'agent.launch' is not available to mobile clients" },
    { code: 'internal_error', message: 'agent_launch_unsupported' }
  ])('treats $code as a reason to fall back to worktree.create', (error) => {
    expect(isAgentLaunchUnsupportedRefusal(error)).toBe(true)
  })

  it.each([
    { code: 'x', message: 'Branch "otter" already exists locally.' },
    { code: 'x', message: 'SSH connection is not available' },
    {}
  ])('leaves a create failure alone (%j)', (error) => {
    expect(isAgentLaunchUnsupportedRefusal(error)).toBe(false)
  })
})
