import { describe, expect, it } from 'vitest'
import {
  agentLaunchCreateParams,
  isAgentLaunchUnsupportedRefusal,
  readAgentLaunchCreateOutcome
} from './agent-launch-request'

describe('agentLaunchCreateParams', () => {
  it('carries the create payload verbatim minus the reserved agent fields', () => {
    // Why: the launch owns placement. A `startupAgent` left in the payload would create the
    // worktree agent-first again, which is exactly the path this method exists to replace.
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
    // A launch can seat the workspace and still fail to finish it — an unspawned pty, untracked
    // files left behind. Dropping the reason is what leaves the phone on a workspace that is
    // quietly wrong. The host reports it at the top level, the same place worktree.create does.
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
