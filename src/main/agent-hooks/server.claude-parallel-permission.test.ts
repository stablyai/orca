import { afterEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../shared/stable-pane-id'
import { AgentHookServer } from './server'

const PANE_KEY = makePaneKey('tab-parallel', '33333333-3333-4333-8333-333333333333')

type ClaudeHookEvent = {
  state: 'working' | 'waiting' | 'done'
  hookEventName: string
  toolName?: string
  toolInput?: string
  toolUseId?: string
  isReplay?: boolean
  prompt?: string
}

function ingestClaudeStatus(server: AgentHookServer, event: ClaudeHookEvent): void {
  server.ingestRemote(
    {
      paneKey: PANE_KEY,
      tabId: 'tab-parallel',
      worktreeId: 'worktree-parallel',
      hookEventName: event.hookEventName,
      ...(event.toolUseId !== undefined ? { toolUseId: event.toolUseId } : {}),
      ...(event.isReplay !== undefined ? { isReplay: event.isReplay } : {}),
      payload: {
        state: event.state,
        agentType: 'claude',
        ...(event.prompt !== undefined ? { prompt: event.prompt } : {}),
        ...(event.toolName !== undefined ? { toolName: event.toolName } : {}),
        ...(event.toolInput !== undefined ? { toolInput: event.toolInput } : {})
      }
    },
    'connection-parallel'
  )
}

function announce(server: AgentHookServer, toolInput: string, toolUseId: string): void {
  ingestClaudeStatus(server, {
    state: 'working',
    hookEventName: 'PreToolUse',
    toolName: 'Bash',
    toolInput,
    toolUseId
  })
}

function requestPermission(server: AgentHookServer, toolInput: string): void {
  ingestClaudeStatus(server, {
    state: 'waiting',
    hookEventName: 'PermissionRequest',
    toolName: 'Bash',
    toolInput
  })
}

function reportBack(server: AgentHookServer, toolInput: string, toolUseId: string): void {
  ingestClaudeStatus(server, {
    state: 'working',
    hookEventName: 'PostToolUse',
    toolName: 'Bash',
    toolInput,
    toolUseId
  })
}

function currentState(server: AgentHookServer): string | undefined {
  return server.getStatusSnapshot()[0]?.state
}

afterEach(() => {
  vi.useRealTimers()
})

describe('Claude permission waits and the call that resumes them', () => {
  it('attaches the approved call’s id and resumes when it reports back', () => {
    // Why: Claude announces every call of a batch before the first prompt opens, so the permission's id
    // must be claimed from the batch — the previous event is a sibling call.
    const server = new AgentHookServer()
    const seen: (string | undefined)[] = []
    server.setListener((payload) => {
      if (payload.hookEventName === 'PermissionRequest') {
        seen.push(payload.toolUseId)
      }
    })

    announce(server, 'git status', 'toolu_a')
    announce(server, 'git log', 'toolu_b')
    requestPermission(server, 'git status')

    expect(currentState(server)).toBe('waiting')
    expect(seen).toEqual(['toolu_a'])

    reportBack(server, 'git status', 'toolu_a')

    expect(currentState(server)).toBe('working')
  })

  it('resumes for the second approval of the same batch', () => {
    // Why: the event before that prompt is the first call's PostToolUse, so a previous-event-only lookup
    // would leave the pane pinned for the rest of the turn.
    const server = new AgentHookServer()

    announce(server, 'git status', 'toolu_a')
    announce(server, 'git log', 'toolu_b')
    requestPermission(server, 'git status')
    reportBack(server, 'git status', 'toolu_a')
    requestPermission(server, 'git log')
    expect(currentState(server)).toBe('waiting')

    reportBack(server, 'git log', 'toolu_b')

    expect(currentState(server)).toBe('working')
  })

  it('claims calls that share an input preview in announcement order', () => {
    // Why: `toolInput` is a truncated preview, so a batch can hold two calls that look identical; each
    // prompt must claim its own call or neither can ever be proven resumed.
    const server = new AgentHookServer()

    announce(server, 'pnpm test', 'toolu_first')
    announce(server, 'pnpm test', 'toolu_second')
    requestPermission(server, 'pnpm test')
    reportBack(server, 'pnpm test', 'toolu_first')
    expect(currentState(server)).toBe('working')

    requestPermission(server, 'pnpm test')
    reportBack(server, 'pnpm test', 'toolu_second')

    expect(currentState(server)).toBe('working')
  })

  it('keeps the wait while a sibling call of the batch runs', () => {
    // Why: an auto-allowed sibling keeps reporting progress while the prompt is still open; only the
    // approved call's own report may clear the glyph.
    const server = new AgentHookServer()

    announce(server, 'git status', 'toolu_a')
    ingestClaudeStatus(server, {
      state: 'working',
      hookEventName: 'PreToolUse',
      toolName: 'Read',
      toolInput: 'src/index.ts',
      toolUseId: 'toolu_b'
    })
    requestPermission(server, 'git status')
    ingestClaudeStatus(server, {
      state: 'working',
      hookEventName: 'PostToolUse',
      toolName: 'Read',
      toolInput: 'src/index.ts',
      toolUseId: 'toolu_b'
    })

    expect(currentState(server)).toBe('waiting')
  })

  it('keeps the wait when an identically previewed sibling completes while the prompt is open', () => {
    // Why: two calls of one batch can share a truncated preview; the sibling finishing is not an answer to
    // the prompt the user is looking at.
    const server = new AgentHookServer()

    announce(server, 'pnpm test', 'toolu_first')
    announce(server, 'pnpm test', 'toolu_second')
    requestPermission(server, 'pnpm test')
    reportBack(server, 'pnpm test', 'toolu_second')

    expect(currentState(server)).toBe('waiting')
  })

  it('reuses the resolved id when the same prompt is delivered twice', () => {
    // Why: a re-delivered PermissionRequest must not claim the sibling's id — that would leave the sibling
    // unprovable for the rest of the turn.
    const server = new AgentHookServer()
    const permissionToolUseIds: (string | undefined)[] = []
    server.setListener((payload) => {
      if (payload.hookEventName === 'PermissionRequest') {
        permissionToolUseIds.push(payload.toolUseId)
      }
    })

    announce(server, 'pnpm test', 'toolu_first')
    announce(server, 'pnpm test', 'toolu_second')
    requestPermission(server, 'pnpm test')
    requestPermission(server, 'pnpm test')

    expect(permissionToolUseIds).toEqual(['toolu_first', 'toolu_first'])

    reportBack(server, 'pnpm test', 'toolu_first')
    expect(currentState(server)).toBe('working')

    requestPermission(server, 'pnpm test')
    reportBack(server, 'pnpm test', 'toolu_second')

    expect(currentState(server)).toBe('working')
  })

  it('keeps the wait when a call that already completed reports again', () => {
    // Why: the hook script retries on timeout and the relay replays on reconnect, so the same completion can
    // arrive twice. A repeat must not answer a prompt that opened afterwards.
    const server = new AgentHookServer()

    announce(server, 'rm -rf dist', 'toolu_done')
    reportBack(server, 'rm -rf dist', 'toolu_done')
    requestPermission(server, 'rm -rf dist')
    reportBack(server, 'rm -rf dist', 'toolu_done')

    expect(currentState(server)).toBe('waiting')
  })

  it('does not let a previous turn’s call answer this turn’s prompt', () => {
    // Why: ids are turn-scoped; a finished call from the last turn must not be adopted by a new prompt,
    // which would then never match the real completion.
    const server = new AgentHookServer()

    announce(server, 'pnpm test', 'toolu_old')
    requestPermission(server, 'pnpm test')
    reportBack(server, 'pnpm test', 'toolu_old')
    ingestClaudeStatus(server, { state: 'done', hookEventName: 'Stop' })
    ingestClaudeStatus(server, {
      state: 'working',
      hookEventName: 'UserPromptSubmit',
      prompt: 'run the tests again'
    })

    // Why: this turn's PreToolUse POST never arrives — the case the safety valve exists for.
    requestPermission(server, 'pnpm test')
    expect(currentState(server)).toBe('waiting')

    reportBack(server, 'pnpm test', 'toolu_new')

    expect(currentState(server)).toBe('working')
  })

  it('keeps the wait when the previous turn’s completion is retried across the boundary', () => {
    // Why: a PostToolUse POST that timed out in the last turn can be retried into this one. The pane no
    // longer has that call queued, but it still remembers seeing the id, so the retry is a repeat — not the
    // approved call of the prompt now on screen.
    const server = new AgentHookServer()

    announce(server, 'pnpm test', 'toolu_previous_turn')
    reportBack(server, 'pnpm test', 'toolu_previous_turn')
    ingestClaudeStatus(server, { state: 'done', hookEventName: 'Stop' })
    ingestClaudeStatus(server, {
      state: 'working',
      hookEventName: 'UserPromptSubmit',
      prompt: 'run the tests again'
    })
    requestPermission(server, 'pnpm test')

    reportBack(server, 'pnpm test', 'toolu_previous_turn')

    expect(currentState(server)).toBe('waiting')
  })

  it('does not let a replayed turn boundary erase what the live stream announced', () => {
    // Why: a relay reconnect can replay a historical UserPromptSubmit after live announcements arrived. If
    // that replay cleared the ledger, this turn's prompt would have no id to claim and would depend on the
    // safety valve instead of on proof — so assert the id, not just the state.
    const server = new AgentHookServer()
    const permissionToolUseIds: (string | undefined)[] = []
    server.setListener((payload) => {
      if (payload.hookEventName === 'PermissionRequest') {
        permissionToolUseIds.push(payload.toolUseId)
      }
    })

    announce(server, 'git status', 'toolu_live')
    ingestClaudeStatus(server, {
      state: 'working',
      hookEventName: 'UserPromptSubmit',
      prompt: 'replayed prompt',
      isReplay: true
    })
    requestPermission(server, 'git status')
    expect(permissionToolUseIds).toEqual(['toolu_live'])

    reportBack(server, 'git status', 'toolu_live')

    expect(currentState(server)).toBe('working')
  })

  it('resumes when the approved call reports back without ever being announced', () => {
    // Why: safety valve — a lost PreToolUse POST leaves no id to claim, so a completion this pane never
    // saw announced is the approved call reporting back.
    const server = new AgentHookServer()

    requestPermission(server, 'git status')
    announce(server, 'git status', 'toolu_a')
    // Why: that PreToolUse fires before the prompt opens, so it must not count as an answer.
    expect(currentState(server)).toBe('waiting')

    reportBack(server, 'git status', 'toolu_a')

    expect(currentState(server)).toBe('working')
  })

  it('ignores replayed rows when deciding what the pane announced', () => {
    // Why: replay is cache continuity, not live hook traffic; recording it would resurrect ids from a turn
    // that has already ended and block the real completion.
    const server = new AgentHookServer()

    ingestClaudeStatus(server, {
      state: 'working',
      hookEventName: 'PreToolUse',
      toolName: 'Bash',
      toolInput: 'git status',
      toolUseId: 'toolu_replayed',
      isReplay: true
    })
    requestPermission(server, 'git status')
    reportBack(server, 'git status', 'toolu_replayed')

    expect(currentState(server)).toBe('working')
  })

  it('still resumes after a long pause on the prompt', () => {
    // Why: the turn stays open while a human decides; evidence must outlive that pause.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const server = new AgentHookServer()

    announce(server, 'git status', 'toolu_a')
    announce(server, 'git log', 'toolu_b')
    requestPermission(server, 'git status')
    vi.setSystemTime(new Date('2026-01-01T00:25:00Z'))
    reportBack(server, 'git status', 'toolu_a')
    requestPermission(server, 'git log')
    expect(currentState(server)).toBe('waiting')

    reportBack(server, 'git log', 'toolu_b')

    expect(currentState(server)).toBe('working')
  })
})
