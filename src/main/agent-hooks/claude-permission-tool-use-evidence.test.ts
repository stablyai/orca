import { describe, expect, it } from 'vitest'
import {
  CLAUDE_ANNOUNCED_TOOL_USE_MAX_PER_PANE,
  CLAUDE_ANNOUNCED_TOOL_USE_TTL_MS,
  clearClaudeAnnouncedToolUses,
  forgetClaudeAnnouncedToolUses,
  forgetClaudeAnnouncedToolUsesWhere,
  moveClaudeAnnouncedToolUses,
  rememberClaudeAnnouncedToolUse,
  resolveClaudeAnnouncedToolUseId,
  retireClaudeAnnouncedToolUse,
  type ClaudeAnnouncedToolUseStore
} from './claude-permission-tool-use-evidence'

const PANE = 'tab:leaf'
const OTHER_PANE = 'other-tab:leaf'
const NOW = 1_000_000

function store(): ClaudeAnnouncedToolUseStore {
  return new Map()
}

function announce(
  announced: ClaudeAnnouncedToolUseStore,
  toolUseId: string,
  toolInput?: string,
  at = NOW,
  paneKey = PANE
): void {
  rememberClaudeAnnouncedToolUse(
    announced,
    paneKey,
    { toolUseId, toolName: 'Bash', ...(toolInput !== undefined ? { toolInput } : {}) },
    at
  )
}

function bashRequest(toolInput?: string): { toolName: string; toolInput?: string } {
  return { toolName: 'Bash', ...(toolInput !== undefined ? { toolInput } : {}) }
}

describe('claude announced tool-use evidence', () => {
  it('resolves a call announced before a sibling of the same batch', () => {
    const announced = store()
    announce(announced, 'toolu_a', 'git status')
    announce(announced, 'toolu_b', 'git log')

    expect(resolveClaudeAnnouncedToolUseId(announced, PANE, bashRequest('git status'), NOW)).toBe(
      'toolu_a'
    )
    expect(resolveClaudeAnnouncedToolUseId(announced, PANE, bashRequest('git log'), NOW)).toBe(
      'toolu_b'
    )
  })

  it('refuses to guess when two live calls look identical', () => {
    // Why: `toolInput` is a truncated preview and MCP tools have none, so identical-looking calls are real.
    // Picking one would attach a sibling's id and let its completion answer a dialog nobody answered.
    const announced = store()
    announce(announced, 'toolu_first', 'pnpm test')
    announce(announced, 'toolu_second', 'pnpm test')

    expect(
      resolveClaudeAnnouncedToolUseId(announced, PANE, bashRequest('pnpm test'), NOW)
    ).toBeUndefined()

    retireClaudeAnnouncedToolUse(announced, PANE, 'toolu_first')

    // Why: once the sibling reports back only one candidate is left, so the answer is unambiguous again.
    expect(resolveClaudeAnnouncedToolUseId(announced, PANE, bashRequest('pnpm test'), NOW)).toBe(
      'toolu_second'
    )
  })

  it('resolves the same id twice — a re-delivered prompt must not consume anything', () => {
    const announced = store()
    announce(announced, 'toolu_a', 'git status')

    expect(resolveClaudeAnnouncedToolUseId(announced, PANE, bashRequest('git status'), NOW)).toBe(
      'toolu_a'
    )
    expect(resolveClaudeAnnouncedToolUseId(announced, PANE, bashRequest('git status'), NOW)).toBe(
      'toolu_a'
    )
  })

  it('does not match a different tool, input, or subagent', () => {
    const announced = store()
    rememberClaudeAnnouncedToolUse(
      announced,
      PANE,
      { toolUseId: 'toolu_a', toolName: 'Bash', toolInput: 'git status', toolAgentId: 'agent-1' },
      NOW
    )

    expect(
      resolveClaudeAnnouncedToolUseId(
        announced,
        PANE,
        { toolName: 'Read', toolInput: 'git status' },
        NOW
      )
    ).toBeUndefined()
    expect(
      resolveClaudeAnnouncedToolUseId(announced, PANE, bashRequest('git log'), NOW)
    ).toBeUndefined()
    expect(
      resolveClaudeAnnouncedToolUseId(announced, PANE, bashRequest('git status'), NOW)
    ).toBeUndefined()
    expect(
      resolveClaudeAnnouncedToolUseId(
        announced,
        PANE,
        { toolName: 'Bash', toolInput: 'git status', toolAgentId: 'agent-1' },
        NOW
      )
    ).toBe('toolu_a')
  })

  it('forgets a call that reported back', () => {
    const announced = store()
    announce(announced, 'toolu_a', 'pnpm test')
    retireClaudeAnnouncedToolUse(announced, PANE, 'toolu_a')

    expect(
      resolveClaudeAnnouncedToolUseId(announced, PANE, bashRequest('pnpm test'), NOW)
    ).toBeUndefined()
    expect(announced.get(PANE)).toBeUndefined()
  })

  it('expires evidence left behind by a turn that never ended', () => {
    const announced = store()
    announce(announced, 'toolu_a', 'ls')

    expect(
      resolveClaudeAnnouncedToolUseId(
        announced,
        PANE,
        bashRequest('ls'),
        NOW + CLAUDE_ANNOUNCED_TOOL_USE_TTL_MS + 1
      )
    ).toBeUndefined()
    expect(
      resolveClaudeAnnouncedToolUseId(
        announced,
        PANE,
        bashRequest('ls'),
        NOW + CLAUDE_ANNOUNCED_TOOL_USE_TTL_MS
      )
    ).toBe('toolu_a')
  })

  it('bounds one pane to the newest announcements and ignores duplicate ids', () => {
    const announced = store()
    for (let index = 0; index < CLAUDE_ANNOUNCED_TOOL_USE_MAX_PER_PANE + 4; index += 1) {
      announce(announced, `toolu_${index}`, `cmd-${index}`, NOW + index)
    }
    for (let index = 0; index < 5; index += 1) {
      announce(announced, 'toolu_repeat', 'cmd-repeat', NOW + 100)
    }

    expect(announced.get(PANE)?.length).toBe(CLAUDE_ANNOUNCED_TOOL_USE_MAX_PER_PANE)
    expect(
      resolveClaudeAnnouncedToolUseId(announced, PANE, bashRequest('cmd-0'), NOW + 100)
    ).toBeUndefined()
    expect(
      resolveClaudeAnnouncedToolUseId(announced, PANE, bashRequest('cmd-repeat'), NOW + 100)
    ).toBe('toolu_repeat')
    expect(
      resolveClaudeAnnouncedToolUseId(
        announced,
        PANE,
        bashRequest(`cmd-${CLAUDE_ANNOUNCED_TOOL_USE_MAX_PER_PANE + 3}`),
        NOW + 100
      )
    ).toBe(`toolu_${CLAUDE_ANNOUNCED_TOOL_USE_MAX_PER_PANE + 3}`)
  })

  it('ignores announcements without an id or tool name', () => {
    const announced = store()
    rememberClaudeAnnouncedToolUse(announced, PANE, { toolName: 'Bash', toolInput: 'ls' }, NOW)
    rememberClaudeAnnouncedToolUse(announced, PANE, { toolUseId: '  ', toolName: 'Bash' }, NOW)
    retireClaudeAnnouncedToolUse(announced, PANE, '   ')

    expect(announced.get(PANE)).toBeUndefined()
  })

  it('drops a pane, a matching set of panes, and everything on request', () => {
    const announced = store()
    announce(announced, 'toolu_a', 'ls')
    forgetClaudeAnnouncedToolUses(announced, PANE)
    expect(announced.get(PANE)).toBeUndefined()

    announce(announced, 'toolu_b', 'ls')
    announce(announced, 'toolu_c', 'ls', NOW, OTHER_PANE)
    forgetClaudeAnnouncedToolUsesWhere(announced, (key) => key === PANE)
    expect(announced.get(PANE)).toBeUndefined()
    expect(announced.get(OTHER_PANE)).toBeDefined()

    clearClaudeAnnouncedToolUses(announced)
    expect(announced.size).toBe(0)
  })

  it('follows a pane through an authority transfer', () => {
    const announced = store()
    announce(announced, 'toolu_a', 'ls')
    moveClaudeAnnouncedToolUses(announced, PANE, OTHER_PANE)

    expect(resolveClaudeAnnouncedToolUseId(announced, PANE, bashRequest('ls'), NOW)).toBeUndefined()
    expect(resolveClaudeAnnouncedToolUseId(announced, OTHER_PANE, bashRequest('ls'), NOW)).toBe(
      'toolu_a'
    )
  })

  it('merges into a destination pane that has evidence of its own', () => {
    const announced = store()
    announce(announced, 'toolu_source', 'git status', NOW)
    announce(announced, 'toolu_destination', 'git log', NOW + 5, OTHER_PANE)

    moveClaudeAnnouncedToolUses(announced, PANE, OTHER_PANE)

    expect(
      resolveClaudeAnnouncedToolUseId(announced, OTHER_PANE, bashRequest('git log'), NOW + 10)
    ).toBe('toolu_destination')
    expect(
      resolveClaudeAnnouncedToolUseId(announced, OTHER_PANE, bashRequest('git status'), NOW + 10)
    ).toBe('toolu_source')
  })

  it('keeps the newest calls of both panes when a merge exceeds the bound', () => {
    // Why: trimming by position would drop a destination call announced seconds ago in favour of an older
    // one carried over from the source pane.
    const announced = store()
    for (let index = 0; index < CLAUDE_ANNOUNCED_TOOL_USE_MAX_PER_PANE; index += 1) {
      announce(announced, `toolu_source_${index}`, `source-${index}`, NOW + index)
    }
    for (let index = 0; index < CLAUDE_ANNOUNCED_TOOL_USE_MAX_PER_PANE; index += 1) {
      announce(
        announced,
        `toolu_destination_${index}`,
        `destination-${index}`,
        NOW + 1_000 + index,
        OTHER_PANE
      )
    }

    moveClaudeAnnouncedToolUses(announced, PANE, OTHER_PANE)

    const at = NOW + 5_000
    expect(announced.get(OTHER_PANE)?.length).toBe(CLAUDE_ANNOUNCED_TOOL_USE_MAX_PER_PANE)
    expect(
      resolveClaudeAnnouncedToolUseId(announced, OTHER_PANE, bashRequest('destination-0'), at)
    ).toBe('toolu_destination_0')
    expect(
      resolveClaudeAnnouncedToolUseId(announced, OTHER_PANE, bashRequest('source-0'), at)
    ).toBeUndefined()
  })

  it('keeps the newer record when both panes hold the same call', () => {
    const announced = store()
    announce(announced, 'toolu_shared', 'cmd', NOW + 5_000)
    announce(announced, 'toolu_shared', 'cmd', NOW, OTHER_PANE)

    moveClaudeAnnouncedToolUses(announced, PANE, OTHER_PANE)

    // Why: the newer record wins, so the entry is still fresh a whole TTL after the older one expired.
    expect(
      resolveClaudeAnnouncedToolUseId(
        announced,
        OTHER_PANE,
        bashRequest('cmd'),
        NOW + CLAUDE_ANNOUNCED_TOOL_USE_TTL_MS + 1
      )
    ).toBe('toolu_shared')
  })
})
