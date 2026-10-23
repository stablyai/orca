import { describe, expect, it } from 'vitest'
import type { RuntimeWorktreePsSummary } from '../../shared/runtime-worktree-contracts'
import { formatVoiceRosterForInstructions, projectVoiceRoster } from './voice-control-roster'

function summary(
  overrides: Partial<RuntimeWorktreePsSummary> & { worktreeId: string; displayName: string }
): RuntimeWorktreePsSummary {
  const base: RuntimeWorktreePsSummary = {
    worktreeId: overrides.worktreeId,
    displayName: overrides.displayName,
    repoId: 'repo-1',
    repo: 'repo',
    path: '/tmp/x',
    branch: 'main',
    isArchived: false,
    isMainWorktree: false,
    hasHostSidebarActivity: false,
    parentWorktreeId: null,
    childWorktreeIds: [],
    workspaceStatus: 'in-progress',
    sortOrder: 0,
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    comment: '',
    isPinned: false,
    isActive: false,
    unread: false,
    liveTerminalCount: 1,
    hasAttachedPty: true,
    lastOutputAt: null,
    preview: '',
    status: 'working',
    agents: []
  }
  return { ...base, ...overrides }
}

describe('projectVoiceRoster', () => {
  it('projects each agent row with its worktree display name', () => {
    const roster = projectVoiceRoster([
      summary({
        worktreeId: 'w1',
        displayName: 'Fix Login',
        agents: [
          {
            paneKey: 'p1',
            parentPaneKey: null,
            state: 'working',
            agentType: 'claude',
            prompt: '',
            taskTitle: 'Fixing login',
            displayName: null,
            lastAssistantMessage: null,
            toolName: null,
            toolInput: null,
            interrupted: false,
            stateStartedAt: 0,
            updatedAt: 0
          }
        ]
      })
    ])
    expect(roster).toEqual([
      {
        spokenName: 'fix login',
        worktreeId: 'w1',
        repoId: 'repo-1',
        paneKey: 'p1',
        agentType: 'claude',
        state: 'working',
        stateStartedAt: 0,
        taskTitle: 'Fixing login',
        toolName: null,
        worktreePath: '/tmp/x',
        hostId: null,
        createdWithAgent: null
      }
    ])
  })

  it('carries the worktree hostId — run_command must not answer a remote row locally', () => {
    const roster = projectVoiceRoster([
      summary({
        worktreeId: 'w1',
        displayName: 'oak',
        hostId: 'ssh:test-host',
        agents: [
          {
            paneKey: 'p1',
            parentPaneKey: null,
            state: 'working',
            agentType: 'claude',
            prompt: '',
            taskTitle: null,
            displayName: null,
            lastAssistantMessage: null,
            toolName: null,
            toolInput: null,
            interrupted: false,
            stateStartedAt: 0,
            updatedAt: 0
          }
        ]
      })
    ])
    expect(roster[0]!.hostId).toBe('ssh:test-host')
  })

  // Live failure: "resume the agent in the ci-type-checking-guard worktree" was
  // unanswerable — worktrees with no running agent were invisible to the coordinator.
  it('projects idle worktrees as resumable entries with an empty paneKey', () => {
    const roster = projectVoiceRoster([
      summary({
        worktreeId: 'w1',
        displayName: 'ci-type-checking-guard',
        createdWithAgent: 'codex',
        liveTerminalCount: 0,
        hasAttachedPty: false
      })
    ])
    expect(roster).toEqual([
      {
        spokenName: 'ci type checking guard',
        worktreeId: 'w1',
        repoId: 'repo-1',
        paneKey: '',
        agentType: null,
        state: 'idle',
        taskTitle: null,
        toolName: null,
        worktreePath: '/tmp/x',
        hostId: null,
        createdWithAgent: 'codex'
      }
    ])
  })

  it('caps idle worktrees most-recently-active first, and skips archived ones', () => {
    const idle = Array.from({ length: 10 }, (_, index) =>
      summary({
        worktreeId: `w${index}`,
        displayName: `idle ${index}`,
        lastActivityAt: index
      })
    )
    const roster = projectVoiceRoster([
      ...idle,
      summary({ worktreeId: 'archived', displayName: 'gone', isArchived: true })
    ])
    expect(roster).toHaveLength(8)
    expect(roster.map((entry) => entry.spokenName)).toEqual([
      'idle 9',
      'idle 8',
      'idle 7',
      'idle 6',
      'idle 5',
      'idle 4',
      'idle 3',
      'idle 2'
    ])
  })

  it('dedupes identical names with stable numeric suffixes', () => {
    const make = (paneKey: string) => ({
      paneKey,
      parentPaneKey: null,
      state: 'waiting' as const,
      agentType: 'codex' as const,
      prompt: '',
      taskTitle: null,
      displayName: null,
      lastAssistantMessage: null,
      toolName: null,
      toolInput: null,
      interrupted: false,
      stateStartedAt: 0,
      updatedAt: 0
    })
    const roster = projectVoiceRoster([
      summary({ worktreeId: 'w1', displayName: 'oak', agents: [make('p1'), make('p2')] }),
      summary({ worktreeId: 'w2', displayName: 'oak!', agents: [make('p3')] })
    ])
    expect(roster.map((entry) => entry.spokenName)).toEqual(['oak', 'oak 2', 'oak 3'])
  })

  // Live failure: the otto repo had the main checkout AND a worktree both displayed as
  // "main" (branches main and j-madrone/main). The coordinator's "main 2" matched nothing
  // the user sees — the sidebar disambiguates with the branch, so the roster does too.
  it('resolves a display-name collision to branch names when branches separate the group', () => {
    const make = (paneKey: string) => ({
      paneKey,
      parentPaneKey: null,
      state: 'working' as const,
      agentType: 'claude' as const,
      prompt: '',
      taskTitle: null,
      displayName: null,
      lastAssistantMessage: null,
      toolName: null,
      toolInput: null,
      interrupted: false,
      stateStartedAt: 0,
      updatedAt: 0
    })
    const roster = projectVoiceRoster([
      summary({
        worktreeId: 'w1',
        displayName: 'main',
        branch: 'main',
        agents: [make('p1')]
      }),
      summary({
        worktreeId: 'w2',
        displayName: 'main',
        branch: 'j-madrone/main',
        agents: [make('p2')]
      })
    ])
    expect(roster.map((entry) => entry.spokenName)).toEqual(['main', 'j madrone main'])
  })

  it('keeps numeric suffixes when branches cannot separate the collided group', () => {
    // Two repos can each have a "main" worktree on branch "main" — the branch adds
    // nothing, so renaming to it would only make the names worse.
    const roster = projectVoiceRoster([
      summary({ worktreeId: 'w1', displayName: 'main', branch: 'main' }),
      summary({ worktreeId: 'w2', displayName: 'main', branch: 'main' })
    ])
    expect(roster.map((entry) => entry.spokenName)).toEqual(['main', 'main 2'])
  })

  it('a live agent and an idle worktree with the same name also disambiguate by branch', () => {
    const roster = projectVoiceRoster([
      summary({
        worktreeId: 'w1',
        displayName: 'main',
        branch: 'main',
        agents: [
          {
            paneKey: 'p1',
            parentPaneKey: null,
            state: 'working',
            agentType: 'claude',
            prompt: '',
            taskTitle: null,
            displayName: null,
            lastAssistantMessage: null,
            toolName: null,
            toolInput: null,
            interrupted: false,
            stateStartedAt: 0,
            updatedAt: 0
          }
        ]
      }),
      summary({
        worktreeId: 'w2',
        displayName: 'main',
        branch: 'j-madrone/main',
        liveTerminalCount: 0,
        hasAttachedPty: false
      })
    ])
    expect(roster.map((entry) => entry.spokenName)).toEqual(['main', 'j madrone main'])
    expect(roster[1]?.state).toBe('idle')
  })

  it('skips archived worktrees', () => {
    const roster = projectVoiceRoster([
      summary({
        worktreeId: 'w1',
        displayName: 'old',
        isArchived: true,
        agents: [
          {
            paneKey: 'p1',
            parentPaneKey: null,
            state: 'waiting',
            agentType: 'claude',
            prompt: '',
            taskTitle: null,
            displayName: null,
            lastAssistantMessage: null,
            toolName: null,
            toolInput: null,
            interrupted: false,
            stateStartedAt: 0,
            updatedAt: 0
          }
        ]
      })
    ])
    expect(roster).toEqual([])
  })
})

describe('formatVoiceRosterForInstructions', () => {
  it('says so when nothing is running', () => {
    expect(formatVoiceRosterForInstructions([])).toBe('No agents are currently running.')
  })

  it('lists spoken names with agent type and activity', () => {
    const text = formatVoiceRosterForInstructions([
      {
        spokenName: 'fix login',
        worktreeId: 'w1',
        repoId: 'repo-1',
        paneKey: 'p1',
        agentType: 'claude',
        state: 'working',
        taskTitle: 'Fixing login',
        toolName: null,
        worktreePath: '/tmp/x',
        hostId: null,
        createdWithAgent: null
      }
    ])
    expect(text).toContain('"fix login"')
    expect(text).toContain('claude')
    expect(text).toContain('working')
    expect(text).toContain('Fixing login')
    expect(text).not.toContain('Idle worktrees')
  })

  it('marks a remote-host agent so the model plans around client-local tools', () => {
    const text = formatVoiceRosterForInstructions([
      {
        spokenName: 'oak',
        worktreeId: 'w1',
        repoId: 'repo-1',
        paneKey: 'p1',
        agentType: 'claude',
        state: 'working',
        taskTitle: null,
        toolName: null,
        worktreePath: '/home/oak',
        hostId: 'ssh:test-host',
        createdWithAgent: null
      }
    ])
    expect(text).toContain('"oak" (claude, working, remote host)')
  })

  // Live failure this pins: a dispatched agent KEEPS its task title after finishing, and
  // the old format showed only the title — "currently: Resume work on issue #4869…" — so
  // the coordinator answered "still in progress" to "are you sure it's not done?" while
  // the pane had been idle for minutes. The state must be on the line, first.
  it('a finished agent shows its state, not just the lingering task title', () => {
    const text = formatVoiceRosterForInstructions([
      {
        spokenName: 'ci type checking guard',
        worktreeId: 'w1',
        repoId: 'repo-1',
        paneKey: 'p1',
        agentType: 'claude',
        state: 'done',
        taskTitle: 'Resume work on issue #4869 in the otto repository',
        toolName: null,
        worktreePath: '/tmp/x',
        hostId: null,
        createdWithAgent: null
      }
    ])
    expect(text).toContain('done — Resume work on issue #4869')
    expect(text).not.toContain('currently:')
  })

  it('a working agent shows state, task, and the running tool', () => {
    const text = formatVoiceRosterForInstructions([
      {
        spokenName: 'oak',
        worktreeId: 'w1',
        repoId: 'repo-1',
        paneKey: 'p1',
        agentType: 'claude',
        state: 'working',
        taskTitle: 'Fix the login redirect',
        toolName: 'Bash',
        worktreePath: '/tmp/x',
        hostId: null,
        createdWithAgent: null
      }
    ])
    expect(text).toContain('working — Fix the login redirect, running Bash')
  })

  it('truncates a whole task spec so the roster stays scannable', () => {
    const text = formatVoiceRosterForInstructions([
      {
        spokenName: 'oak',
        worktreeId: 'w1',
        repoId: 'repo-1',
        paneKey: 'p1',
        agentType: 'claude',
        state: 'working',
        taskTitle: 'x'.repeat(200),
        toolName: null,
        worktreePath: '/tmp/x',
        hostId: null,
        createdWithAgent: null
      }
    ])
    expect(text).toContain(`${'x'.repeat(79)}…`)
    expect(text).not.toContain('x'.repeat(81))
  })

  it('names idle worktrees as start_agent candidates', () => {
    const text = formatVoiceRosterForInstructions([
      {
        spokenName: 'ci type checking guard',
        worktreeId: 'w1',
        repoId: 'repo-1',
        paneKey: '',
        agentType: null,
        state: 'idle',
        taskTitle: null,
        toolName: null,
        worktreePath: '/tmp/x',
        hostId: null,
        createdWithAgent: 'codex'
      }
    ])
    expect(text).toContain('Idle worktrees with no running agent')
    expect(text).toContain('ci type checking guard')
    expect(text).toContain('start_agent')
  })
})
