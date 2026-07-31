import { describe, expect, it } from 'vitest'
import {
  CLAUDE_PENDING_TOOL_USE_MAX_PER_PANE,
  CLAUDE_PENDING_TOOL_USE_TTL_MS,
  clearClaudePendingToolUses,
  forgetClaudePendingToolUses,
  forgetClaudePendingToolUsesWhere,
  isClaudeToolUseUnaccountedFor,
  moveClaudePendingToolUses,
  rememberClaudePendingToolUse,
  retireClaudeCompletedToolUse,
  takeClaudePendingToolUseId,
  type ClaudePendingToolUseStore
} from './claude-permission-tool-use-evidence'

const PANE = 'tab:leaf'
const OTHER_PANE = 'other-tab:leaf'
const NOW = 1_000_000

function store(): ClaudePendingToolUseStore {
  return new Map()
}

function announce(
  pending: ClaudePendingToolUseStore,
  toolUseId: string,
  toolInput?: string,
  at = NOW,
  paneKey = PANE
): void {
  rememberClaudePendingToolUse(
    pending,
    paneKey,
    { toolUseId, toolName: 'Bash', ...(toolInput !== undefined ? { toolInput } : {}) },
    at
  )
}

describe('claude pending tool-use evidence', () => {
  it('claims the id of a batch sibling announced before the latest call', () => {
    const pending = store()
    announce(pending, 'toolu_a', 'git status')
    announce(pending, 'toolu_b', 'git log')

    expect(
      takeClaudePendingToolUseId(pending, PANE, { toolName: 'Bash', toolInput: 'git status' }, NOW)
    ).toBe('toolu_a')
  })

  it('claims calls sharing an input preview in announcement order, one prompt each', () => {
    // Why: `toolInput` is a truncated preview, so a batch can hold two calls that look identical; claiming
    // newest-first would hand each prompt its sibling's id and neither could ever be proven resumed.
    const pending = store()
    announce(pending, 'toolu_first', 'pnpm test')
    announce(pending, 'toolu_second', 'pnpm test')

    const request = { toolName: 'Bash', toolInput: 'pnpm test' }
    expect(takeClaudePendingToolUseId(pending, PANE, request, NOW)).toBe('toolu_first')
    expect(takeClaudePendingToolUseId(pending, PANE, request, NOW)).toBe('toolu_second')
    expect(takeClaudePendingToolUseId(pending, PANE, request, NOW)).toBeUndefined()
  })

  it('retires a completed call so a later prompt cannot adopt its id', () => {
    const pending = store()
    announce(pending, 'toolu_a', 'pnpm test')
    retireClaudeCompletedToolUse(pending, PANE, 'toolu_a')

    expect(
      takeClaudePendingToolUseId(pending, PANE, { toolName: 'Bash', toolInput: 'pnpm test' }, NOW)
    ).toBeUndefined()
  })

  it('tells the prompt’s own call apart from ids the pane already knew', () => {
    const pending = store()
    const promptCachedAt = NOW + 50
    announce(pending, 'toolu_before_prompt', 'ls', NOW)
    announce(pending, 'toolu_after_prompt', 'ls', promptCachedAt + 10)
    retireClaudeCompletedToolUse(pending, PANE, 'toolu_completed')

    // Why: a sibling announced before the prompt, or an id already completed, cannot be the call the user
    // was asked about; an id announced only afterwards — or never — can.
    expect(
      isClaudeToolUseUnaccountedFor(pending, PANE, 'toolu_before_prompt', promptCachedAt)
    ).toBe(false)
    expect(isClaudeToolUseUnaccountedFor(pending, PANE, 'toolu_completed', promptCachedAt)).toBe(
      false
    )
    expect(isClaudeToolUseUnaccountedFor(pending, PANE, 'toolu_after_prompt', promptCachedAt)).toBe(
      true
    )
    expect(isClaudeToolUseUnaccountedFor(pending, PANE, 'toolu_never_seen', promptCachedAt)).toBe(
      true
    )
    expect(
      isClaudeToolUseUnaccountedFor(pending, OTHER_PANE, 'toolu_before_prompt', promptCachedAt)
    ).toBe(true)
    expect(isClaudeToolUseUnaccountedFor(pending, PANE, undefined, promptCachedAt)).toBe(false)
  })

  it('does not match a different tool, input, or subagent', () => {
    const pending = store()
    rememberClaudePendingToolUse(
      pending,
      PANE,
      { toolUseId: 'toolu_a', toolName: 'Bash', toolInput: 'git status', toolAgentId: 'agent-1' },
      NOW
    )

    expect(
      takeClaudePendingToolUseId(pending, PANE, { toolName: 'Read', toolInput: 'git status' }, NOW)
    ).toBeUndefined()
    expect(
      takeClaudePendingToolUseId(pending, PANE, { toolName: 'Bash', toolInput: 'git log' }, NOW)
    ).toBeUndefined()
    expect(
      takeClaudePendingToolUseId(pending, PANE, { toolName: 'Bash', toolInput: 'git status' }, NOW)
    ).toBeUndefined()
    expect(
      takeClaudePendingToolUseId(
        pending,
        PANE,
        { toolName: 'Bash', toolInput: 'git status', toolAgentId: 'agent-1' },
        NOW
      )
    ).toBe('toolu_a')
  })

  it('expires evidence left behind by a turn that never ended', () => {
    const pending = store()
    announce(pending, 'toolu_a', 'ls')

    expect(
      takeClaudePendingToolUseId(
        pending,
        PANE,
        { toolName: 'Bash', toolInput: 'ls' },
        NOW + CLAUDE_PENDING_TOOL_USE_TTL_MS + 1
      )
    ).toBeUndefined()
  })

  it('bounds one pane to the newest announcements and ignores duplicate ids', () => {
    const pending = store()
    for (let index = 0; index < CLAUDE_PENDING_TOOL_USE_MAX_PER_PANE + 4; index += 1) {
      announce(pending, `toolu_${index}`, `cmd-${index}`, NOW + index)
    }
    for (let index = 0; index < 5; index += 1) {
      announce(pending, 'toolu_repeat', 'cmd-repeat', NOW + 100)
    }

    const request = (input: string): { toolName: string; toolInput: string } => ({
      toolName: 'Bash',
      toolInput: input
    })
    // Why: the oldest announcements are the ones dropped, and a repeat leaves exactly one claimable entry.
    expect(takeClaudePendingToolUseId(pending, PANE, request('cmd-0'), NOW + 100)).toBeUndefined()
    expect(takeClaudePendingToolUseId(pending, PANE, request('cmd-repeat'), NOW + 100)).toBe(
      'toolu_repeat'
    )
    expect(
      takeClaudePendingToolUseId(pending, PANE, request('cmd-repeat'), NOW + 100)
    ).toBeUndefined()
    expect(
      takeClaudePendingToolUseId(
        pending,
        PANE,
        request(`cmd-${CLAUDE_PENDING_TOOL_USE_MAX_PER_PANE + 3}`),
        NOW + 100
      )
    ).toBe(`toolu_${CLAUDE_PENDING_TOOL_USE_MAX_PER_PANE + 3}`)
    // Why: the id history shares the bound, so the oldest trimmed id also stops counting as accounted for.
    expect(isClaudeToolUseUnaccountedFor(pending, PANE, 'toolu_0', NOW + 100)).toBe(true)
    expect(
      isClaudeToolUseUnaccountedFor(
        pending,
        PANE,
        `toolu_${CLAUDE_PENDING_TOOL_USE_MAX_PER_PANE + 3}`,
        NOW + 100
      )
    ).toBe(false)
  })

  it('ignores announcements without an id or tool name', () => {
    const pending = store()
    rememberClaudePendingToolUse(pending, PANE, { toolName: 'Bash', toolInput: 'ls' }, NOW)
    rememberClaudePendingToolUse(pending, PANE, { toolUseId: '  ', toolName: 'Bash' }, NOW)
    retireClaudeCompletedToolUse(pending, PANE, '   ')

    expect(pending.get(PANE)).toBeUndefined()
  })

  it('drops a pane, a matching set of panes, and everything on request', () => {
    const pending = store()
    announce(pending, 'toolu_a', 'ls')
    forgetClaudePendingToolUses(pending, PANE)
    expect(pending.get(PANE)).toBeUndefined()

    announce(pending, 'toolu_b', 'ls')
    announce(pending, 'toolu_c', 'ls', NOW, OTHER_PANE)
    forgetClaudePendingToolUsesWhere(pending, (key) => key === PANE)
    expect(pending.get(PANE)).toBeUndefined()
    expect(pending.get(OTHER_PANE)).toBeDefined()

    clearClaudePendingToolUses(pending)
    expect(pending.size).toBe(0)
  })

  it('follows a pane through an authority transfer', () => {
    const pending = store()
    announce(pending, 'toolu_a', 'ls')
    moveClaudePendingToolUses(pending, PANE, OTHER_PANE)

    expect(
      takeClaudePendingToolUseId(pending, PANE, { toolName: 'Bash', toolInput: 'ls' }, NOW)
    ).toBeUndefined()
    expect(
      takeClaudePendingToolUseId(pending, OTHER_PANE, { toolName: 'Bash', toolInput: 'ls' }, NOW)
    ).toBe('toolu_a')
  })

  it('merges into a destination pane that has evidence of its own', () => {
    // Why: a live destination pane has announced calls too; replacing its ledger would orphan them and its
    // own prompts could never attach an id.
    const pending = store()
    announce(pending, 'toolu_source', 'git status', NOW)
    announce(pending, 'toolu_destination', 'git log', NOW + 5, OTHER_PANE)
    retireClaudeCompletedToolUse(pending, OTHER_PANE, 'toolu_destination_done')

    moveClaudePendingToolUses(pending, PANE, OTHER_PANE)

    expect(
      takeClaudePendingToolUseId(
        pending,
        OTHER_PANE,
        { toolName: 'Bash', toolInput: 'git log' },
        NOW
      )
    ).toBe('toolu_destination')
    expect(
      takeClaudePendingToolUseId(
        pending,
        OTHER_PANE,
        { toolName: 'Bash', toolInput: 'git status' },
        NOW
      )
    ).toBe('toolu_source')
    expect(isClaudeToolUseUnaccountedFor(pending, OTHER_PANE, 'toolu_source', NOW + 10)).toBe(false)
    expect(
      isClaudeToolUseUnaccountedFor(pending, OTHER_PANE, 'toolu_destination_done', NOW + 10)
    ).toBe(false)
  })
})
