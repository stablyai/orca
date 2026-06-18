import { describe, expect, it } from 'vitest'
import { z, type ZodType } from 'zod'
import {
  BrowserTarget,
  OptionalBoolean,
  OptionalFiniteNumber,
  OptionalPlainString,
  OptionalPositiveInt,
  OptionalString
} from './schemas'
import {
  InterceptEnable,
  Screenshot,
  Scroll,
  TabClose,
  TabSwitch,
  Wait
} from './methods/browser-schemas'
import { TERMINAL_METHODS } from './methods/terminal'
import { WORKTREE_METHODS } from './methods/worktree'
import { FORK_METHODS } from './methods/fork'

function expectParses(schema: ZodType, value: unknown): void {
  const result = schema.safeParse(value)
  expect(result.success, result.success ? undefined : JSON.stringify(result.error.issues)).toBe(
    true
  )
}

function expectRejects(schema: ZodType, value: unknown): void {
  const result = schema.safeParse(value)
  expect(result.success).toBe(false)
}

function methodParams(
  methods: readonly { name: string; params: ZodType | null }[],
  name: string
): ZodType {
  const method = methods.find((candidate) => candidate.name === name)
  if (!method?.params) {
    throw new Error(`missing test method schema: ${name}`)
  }
  return method.params
}

describe('RPC optional pipe schemas', () => {
  it('accepts omitted shared optional helper fields', () => {
    const schema = z.object({
      finite: OptionalFiniteNumber,
      positive: OptionalPositiveInt,
      string: OptionalString,
      plain: OptionalPlainString,
      boolean: OptionalBoolean
    })

    expectParses(schema, {})
  })

  it('accepts omitted browser optional fields while required fields are present', () => {
    expectParses(Scroll, { direction: 'down' })
    expectParses(Screenshot, {})
    expectParses(TabSwitch, { page: 'page-1' })
    expectParses(TabClose, {})
    expectParses(Wait, {})
    expectParses(InterceptEnable, {})
    expectParses(BrowserTarget, {})
  })

  it('accepts omitted terminal and worktree optional fields while required fields are present', () => {
    expectParses(methodParams(TERMINAL_METHODS, 'terminal.split'), { terminal: 'terminal-1' })
    expectParses(methodParams(TERMINAL_METHODS, 'terminal.split'), {
      terminal: 'terminal-1',
      telemetrySource: 'contextual_tour'
    })
    expectRejects(methodParams(TERMINAL_METHODS, 'terminal.split'), {
      terminal: 'terminal-1',
      telemetrySource: 'raw-source'
    })
    expectParses(methodParams(WORKTREE_METHODS, 'worktree.create'), { repo: 'repo-1' })
    expectParses(methodParams(WORKTREE_METHODS, 'worktree.set'), {
      worktree: 'id:wt-1',
      linkedLinearIssue: 'STA-335',
      linkedLinearIssueWorkspaceId: null,
      linkedLinearIssueOrganizationUrlKey: 'stably'
    })
    expectParses(methodParams(WORKTREE_METHODS, 'worktree.prefetchCreateBase'), { repo: 'repo-1' })
    expectParses(methodParams(FORK_METHODS, 'fork.create'), {
      terminal: 'term-1',
      name: 'child',
      activate: true,
      fallbackContextSource: 'structured',
      maxContextChars: 72000,
      transcriptLineLimit: 1600
    })
    expectParses(methodParams(FORK_METHODS, 'fork.preflight'), {
      terminal: 'term-1',
      noCopyFiles: true
    })
    expectParses(methodParams(FORK_METHODS, 'fork.create'), {
      worktree: 'id:wt-1',
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'claude-session-1' },
      promptInteractions: [
        {
          id: 'claude-message-1',
          prompt: 'first prompt',
          observedAt: 1_000,
          agentType: 'claude'
        }
      ]
    })
    expectParses(methodParams(FORK_METHODS, 'fork.create'), {
      worktree: 'id:wt-1',
      agent: 'pi',
      providerSession: {
        key: 'session_path',
        id: '/home/dev/.pi/agent/sessions/--repo--/20260617_session.jsonl'
      }
    })
    expectRejects(methodParams(FORK_METHODS, 'fork.create'), {
      terminal: 'term-1',
      worktree: 'id:wt-1',
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'claude-session-1' }
    })
    expectRejects(methodParams(FORK_METHODS, 'fork.create'), {
      promptInteractions: [
        {
          id: 'gemini-message-1',
          prompt: 'first prompt',
          observedAt: 1_000,
          agentType: 'gemini'
        }
      ]
    })
    expectRejects(methodParams(FORK_METHODS, 'fork.preflight'), {
      worktree: 'id:wt-1',
      agent: 'codex',
      providerSession: { key: 'session_id', id: '--unsafe' }
    })
    expectRejects(methodParams(FORK_METHODS, 'fork.create'), {
      terminal: 'term-1',
      fallbackContextSource: 'screen'
    })
    expectRejects(methodParams(FORK_METHODS, 'fork.create'), {
      terminal: 'term-1',
      maxContextChars: 999
    })
    expectRejects(methodParams(FORK_METHODS, 'fork.create'), {
      terminal: 'term-1',
      maxContextChars: '72000'
    })
    expectRejects(methodParams(FORK_METHODS, 'fork.create'), {
      terminal: 'term-1',
      transcriptLineLimit: 5001
    })
    expectRejects(methodParams(FORK_METHODS, 'fork.create'), {
      terminal: 'term-1',
      transcriptLineLimit: '1600'
    })
    expectParses(methodParams(FORK_METHODS, 'fork.show'), { fork: 'repo::/tmp/child' })
    expectParses(methodParams(FORK_METHODS, 'fork.diff'), { fork: 'repo::/tmp/child' })
  })
})
