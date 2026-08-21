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
import { TERMINAL_ORPHAN_METHODS } from './methods/terminal-orphan'
import { WORKTREE_METHODS } from './methods/worktree'

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
  })

  it('requires complete, bounded orphan adoption claims and a topology revision', () => {
    const adopt = methodParams(TERMINAL_ORPHAN_METHODS, 'terminal.adoptOrphans')
    const claim = {
      terminal: 'term-live',
      ptyId: 'pty-live',
      incarnationId: 'inc-live',
      tabId: 'tab-live',
      leafId: 'leaf-live'
    }

    expectParses(adopt, {
      worktree: 'id:repo::/worktree',
      expectedTopologyRevision: 4,
      claims: [claim],
      topology: {
        tabs: [
          {
            tabId: 'tab-live',
            root: { type: 'leaf', leafId: 'leaf-live' },
            activeLeafId: 'leaf-live',
            expandedLeafId: null
          }
        ],
        groups: [{ id: 'group-live', activeTabId: 'tab-live', tabOrder: ['tab-live'] }],
        groupLayout: { type: 'leaf', groupId: 'group-live' }
      }
    })
    expectRejects(adopt, {
      worktree: 'id:repo::/worktree',
      expectedTopologyRevision: -1,
      claims: [claim]
    })
    expectRejects(adopt, {
      worktree: 'id:repo::/worktree',
      expectedTopologyRevision: 4,
      claims: [{ ...claim, incarnationId: '' }]
    })
    expectRejects(adopt, {
      worktree: 'id:repo::/worktree',
      expectedTopologyRevision: 4,
      claims: [{ ...claim, incarnationId: 'i'.repeat(129) }]
    })
    expectRejects(adopt, {
      worktree: 'id:repo::/worktree',
      expectedTopologyRevision: 4,
      claims: []
    })
    expectRejects(adopt, {
      worktree: 'id:repo::/worktree',
      expectedTopologyRevision: 4,
      claims: [{ ...claim, terminal: 't'.repeat(257) }]
    })
    expectRejects(adopt, {
      worktree: 'id:repo::/worktree',
      expectedTopologyRevision: 4,
      claims: [claim],
      topology: {
        tabs: [
          {
            tabId: 'tab-live',
            root: {
              type: 'split',
              direction: 'horizontal',
              ratio: Number.NaN,
              first: { type: 'leaf', leafId: 'leaf-live' },
              second: { type: 'leaf', leafId: 'leaf-other' }
            },
            activeLeafId: 'leaf-live',
            expandedLeafId: null
          }
        ],
        groups: [{ id: 'group-live', activeTabId: 'tab-live', tabOrder: ['tab-live'] }]
      }
    })
  })

  it('bounds targeted terminal listing used by orphan recovery', () => {
    const list = methodParams(TERMINAL_METHODS, 'terminal.list')

    expectParses(list, { worktree: 'id:repo::/worktree', handles: ['term-live'] })
    expectRejects(list, { handles: [''] })
    expectRejects(list, { handles: Array.from({ length: 65 }, (_, index) => `term-${index}`) })
  })

  it('accepts worktree.create payloads sent by the previous mobile protocol', () => {
    const create = methodParams(WORKTREE_METHODS, 'worktree.create')

    expectParses(create, {
      repo: 'id:repo-github',
      name: 'fix-mobile-tasks',
      displayName: 'Fix mobile tasks',
      setupDecision: 'run',
      activate: true,
      startupDraft: 'https://github.com/acme/app/pull/123',
      createdWithAgent: 'codex',
      linkedPR: 123,
      baseBranch: 'origin/main',
      compareBaseRef: 'origin/main',
      branchNameOverride: 'feature/mobile-tasks',
      pushTarget: { remoteName: 'origin', branchName: 'feature/mobile-tasks' }
    })
    expectParses(create, {
      repo: 'id:repo-gitlab',
      name: 'mr-7',
      linkedGitLabMR: 7,
      sparseCheckout: { directories: ['mobile'], presetId: 'mobile' },
      comment: 'keep mobile parity'
    })
    expectParses(create, {
      repo: 'id:repo-linear',
      name: 'eng-42',
      linkedLinearIssue: 'ENG-42',
      linkedLinearIssueWorkspaceId: 'workspace-1',
      linkedLinearIssueOrganizationUrlKey: 'acme'
    })
  })
})
