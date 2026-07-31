import { describe, expect, it } from 'vitest'
import { makePaneKey } from '../../shared/stable-pane-id'
import { AgentHookServer } from './server'

const TAB_ID = 'tab-parallel'
const PANE_KEY = makePaneKey(TAB_ID, '33333333-3333-4333-8333-333333333333')
const OTHER_PANE_KEY = makePaneKey(TAB_ID, '44444444-4444-4444-8444-444444444444')

type ClaudeHookEvent = {
  state: 'working' | 'waiting' | 'done'
  hookEventName: string
  toolName?: string
  toolInput?: string
  toolUseId?: string
  isReplay?: boolean
  prompt?: string
  paneKey?: string
}

function ingestClaudeStatus(server: AgentHookServer, event: ClaudeHookEvent): void {
  server.ingestRemote(
    {
      paneKey: event.paneKey ?? PANE_KEY,
      tabId: TAB_ID,
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

function announce(
  server: AgentHookServer,
  toolInput: string,
  toolUseId: string,
  paneKey?: string
): void {
  ingestClaudeStatus(server, {
    state: 'working',
    hookEventName: 'PreToolUse',
    toolName: 'Bash',
    toolInput,
    toolUseId,
    ...(paneKey !== undefined ? { paneKey } : {})
  })
}

function requestPermission(server: AgentHookServer, toolInput: string, paneKey?: string): void {
  ingestClaudeStatus(server, {
    state: 'waiting',
    hookEventName: 'PermissionRequest',
    toolName: 'Bash',
    toolInput,
    ...(paneKey !== undefined ? { paneKey } : {})
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

function currentState(server: AgentHookServer, paneKey = PANE_KEY): string | undefined {
  return server.getStatusSnapshot().find((row) => row.paneKey === paneKey)?.state
}

/** Records the id each emitted `PermissionRequest` row carries — the proof that the prompt was paired with
 *  its own call, which a state assertion alone cannot tell apart from a lucky guess. */
function permissionToolUseIds(server: AgentHookServer): (string | undefined)[] {
  const ids: (string | undefined)[] = []
  server.setListener((payload) => {
    if (payload.hookEventName === 'PermissionRequest') {
      ids.push(payload.toolUseId)
    }
  })
  return ids
}

describe('Claude permission waits and the call that resumes them', () => {
  it('pairs a prompt with its own call when a batch sibling was announced in between', () => {
    const server = new AgentHookServer()
    const ids = permissionToolUseIds(server)

    announce(server, 'git status', 'toolu_a')
    announce(server, 'git log', 'toolu_b')
    requestPermission(server, 'git status')

    expect(ids).toEqual(['toolu_a'])
    expect(currentState(server)).toBe('waiting')

    reportBack(server, 'git status', 'toolu_a')

    expect(currentState(server)).toBe('working')
  })

  it('pairs a prompt with an announcement that only arrives after the dialog is open', () => {
    // Why: hook POSTs race, so the prompt regularly reaches the server before its own PreToolUse. The late
    // announcement must still bind, or the approval that follows can never be recognised.
    const server = new AgentHookServer()

    requestPermission(server, 'git status')
    announce(server, 'git status', 'toolu_a')

    // Why: an announcement fires before its dialog opens, so it is never itself an answer.
    expect(currentState(server)).toBe('waiting')

    reportBack(server, 'git status', 'toolu_a')

    expect(currentState(server)).toBe('working')
  })

  it('does not bind a late announcement that is not the prompted call', () => {
    const server = new AgentHookServer()

    requestPermission(server, 'git status')
    ingestClaudeStatus(server, {
      state: 'working',
      hookEventName: 'PreToolUse',
      toolName: 'Read',
      toolInput: 'src/index.ts',
      toolUseId: 'toolu_other'
    })
    ingestClaudeStatus(server, {
      state: 'working',
      hookEventName: 'PostToolUse',
      toolName: 'Read',
      toolInput: 'src/index.ts',
      toolUseId: 'toolu_other'
    })

    expect(currentState(server)).toBe('waiting')
  })

  it('refuses to pair when two live calls look identical', () => {
    // Why: a truncated preview can hide the difference between two calls. Guessing would let a sibling's
    // completion clear a dialog the user has not answered, so the pane stays waiting until the turn ends.
    const server = new AgentHookServer()
    const ids = permissionToolUseIds(server)

    announce(server, 'pnpm test', 'toolu_first')
    announce(server, 'pnpm test', 'toolu_second')
    requestPermission(server, 'pnpm test')

    expect(ids).toEqual([undefined])

    reportBack(server, 'pnpm test', 'toolu_second')

    expect(currentState(server)).toBe('waiting')
  })

  it('pairs the second prompt of a batch once its sibling has reported back', () => {
    const server = new AgentHookServer()
    const ids = permissionToolUseIds(server)

    announce(server, 'git status', 'toolu_a')
    announce(server, 'git log', 'toolu_b')
    requestPermission(server, 'git status')
    reportBack(server, 'git status', 'toolu_a')
    requestPermission(server, 'git log')
    expect(currentState(server)).toBe('waiting')

    reportBack(server, 'git log', 'toolu_b')

    expect(ids).toEqual(['toolu_a', 'toolu_b'])
    expect(currentState(server)).toBe('working')
  })

  it('keeps the wait while a sibling call of the batch runs', () => {
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

  it('resolves a re-delivered prompt to the same call', () => {
    // Why: resolution is read-only, so a retried POST of one prompt cannot take its sibling's id.
    const server = new AgentHookServer()
    const ids = permissionToolUseIds(server)

    announce(server, 'git status', 'toolu_a')
    announce(server, 'git log', 'toolu_b')
    requestPermission(server, 'git status')
    requestPermission(server, 'git status')

    expect(ids).toEqual(['toolu_a', 'toolu_a'])

    requestPermission(server, 'git log')
    reportBack(server, 'git log', 'toolu_b')

    expect(currentState(server)).toBe('working')
  })

  it('resumes when the approved call reports a failure', () => {
    // Why: a failing call still answers its prompt, and its payload carries no tool name — only the id.
    const server = new AgentHookServer()

    announce(server, 'pnpm test', 'toolu_a')
    requestPermission(server, 'pnpm test')
    ingestClaudeStatus(server, {
      state: 'working',
      hookEventName: 'PostToolUseFailure',
      toolUseId: 'toolu_a'
    })

    expect(currentState(server)).toBe('working')
  })

  it('keeps the wait when a completion this pane never announced arrives', () => {
    // Why: an unknown id can be a replay, a retry from an earlier turn, or a call whose announcement was
    // lost — none of them prove the user answered the dialog on screen.
    const server = new AgentHookServer()

    requestPermission(server, 'git status')
    reportBack(server, 'git status', 'toolu_unknown')

    expect(currentState(server)).toBe('waiting')
  })

  it('ignores replayed rows when pairing and when recording', () => {
    const server = new AgentHookServer()
    const ids = permissionToolUseIds(server)

    ingestClaudeStatus(server, {
      state: 'working',
      hookEventName: 'PreToolUse',
      toolName: 'Bash',
      toolInput: 'git status',
      toolUseId: 'toolu_replayed',
      isReplay: true
    })
    requestPermission(server, 'git status')
    expect(ids).toEqual([undefined])

    ingestClaudeStatus(server, {
      state: 'working',
      hookEventName: 'PostToolUse',
      toolName: 'Bash',
      toolInput: 'git status',
      toolUseId: 'toolu_replayed',
      isReplay: true
    })

    expect(currentState(server)).toBe('waiting')
  })

  it('does not let a replayed prompt bind a live call', () => {
    const server = new AgentHookServer()
    const ids = permissionToolUseIds(server)

    announce(server, 'git status', 'toolu_a')
    ingestClaudeStatus(server, {
      state: 'waiting',
      hookEventName: 'PermissionRequest',
      toolName: 'Bash',
      toolInput: 'git status',
      isReplay: true
    })
    requestPermission(server, 'git status')

    // Why: the replayed prompt binds nothing, and the live one that follows still finds its own call.
    expect(ids).toEqual([undefined, 'toolu_a'])
  })

  it('does not carry an abandoned call across a turn boundary', () => {
    // Why: the previous turn's calls stop being answers; a new prompt must pair with this turn's own call.
    const server = new AgentHookServer()

    announce(server, 'pnpm test', 'toolu_abandoned')
    ingestClaudeStatus(server, { state: 'done', hookEventName: 'Stop' })
    ingestClaudeStatus(server, {
      state: 'working',
      hookEventName: 'UserPromptSubmit',
      prompt: 'run the tests again'
    })
    const ids = permissionToolUseIds(server)
    requestPermission(server, 'pnpm test')

    expect(ids).toEqual([undefined])

    announce(server, 'pnpm test', 'toolu_new')
    reportBack(server, 'pnpm test', 'toolu_new')

    expect(currentState(server)).toBe('working')
  })

  it('keeps the wait when the previous turn’s completion is retried across the boundary', () => {
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
    const server = new AgentHookServer()

    announce(server, 'git status', 'toolu_live')
    ingestClaudeStatus(server, {
      state: 'working',
      hookEventName: 'UserPromptSubmit',
      prompt: 'replayed prompt',
      isReplay: true
    })
    const ids = permissionToolUseIds(server)
    requestPermission(server, 'git status')

    expect(ids).toEqual(['toolu_live'])
  })
})

describe('Claude announced tool-use evidence follows the pane lifecycle', () => {
  function announcedPaneKeys(server: AgentHookServer): string[] {
    return [...server._getClaudeAnnouncedToolUsesForTests().keys()]
  }

  it('drops evidence when the status row is dismissed', () => {
    const server = new AgentHookServer()
    announce(server, 'git status', 'toolu_a')

    server.dropStatusEntry(PANE_KEY)

    expect(announcedPaneKeys(server)).toEqual([])
  })

  it('drops evidence when the pane is torn down', () => {
    const server = new AgentHookServer()
    announce(server, 'git status', 'toolu_a')

    server.clearPaneState(PANE_KEY)

    expect(announcedPaneKeys(server)).toEqual([])
  })

  it('drops evidence for every pane of a closed tab', () => {
    const server = new AgentHookServer()
    announce(server, 'git status', 'toolu_a')

    server.dropStatusEntriesByTabPrefix(TAB_ID)

    expect(announcedPaneKeys(server)).toEqual([])
  })

  it('drops every pane’s evidence when the server stops', () => {
    const server = new AgentHookServer()
    announce(server, 'git status', 'toolu_a')

    server.stop()

    expect(announcedPaneKeys(server)).toEqual([])
  })

  it('follows the pane through an authority transfer', () => {
    const server = new AgentHookServer()
    announce(server, 'git status', 'toolu_a')

    server.transferPaneAuthority(PANE_KEY, OTHER_PANE_KEY, 'pty-transfer')
    const ids = permissionToolUseIds(server)
    requestPermission(server, 'git status', OTHER_PANE_KEY)

    expect(ids).toEqual(['toolu_a'])
    expect(currentState(server, OTHER_PANE_KEY)).toBe('waiting')
  })
})
