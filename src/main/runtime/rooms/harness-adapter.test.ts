import { describe, expect, it, vi } from 'vitest'
import { EMPTY_ROOM_CONTEXT } from '../../../shared/room-context'
import { ROOM_HARNESS_AGENTS, type RoomHarnessAgent } from '../../../shared/rooms'
import {
  createRoomHarnessAdapters,
  transcriptLifecycleEvent,
  type RoomHarnessRuntime
} from './harness-adapter'

function runtimeStub(): RoomHarnessRuntime {
  return {
    createAgentSession: vi.fn(async (request) => ({
      terminal: {
        handle: `term_${request.agent}`,
        paneKey: `tab:${request.agent}`,
        worktreeId: request.worktree.slice(3),
        title: null
      },
      disposition: 'created' as const
    })),
    ensureAgentSession: vi.fn(async (request) => ({
      terminal: {
        handle: `term_${request.kind === 'explicit' ? request.agent : 'automatic'}`,
        paneKey: `tab:${request.kind === 'explicit' ? request.agent : 'automatic'}`,
        worktreeId: request.kind === 'explicit' ? request.worktree.slice(3) : 'automatic',
        title: null
      },
      disposition: 'adopted' as const
    })),
    sendTerminalAgentPrompt: vi.fn(async (handle, prompt) => ({
      handle,
      accepted: true,
      bytesWritten: Buffer.byteLength(prompt)
    })),
    sendTerminal: vi.fn(async (handle, action) => ({
      handle,
      accepted: true,
      bytesWritten: Buffer.byteLength(action.text ?? '')
    })),
    waitForTerminalAgentInputReady: vi.fn(async () => true),
    compactTerminalAgentSession: vi.fn(async (handle) => ({
      handle,
      accepted: true,
      bytesWritten: 9
    })),
    getTerminalAgentStatus: vi.fn(async (handle) => ({
      handle,
      isRunningAgent: true,
      status: 'idle' as const
    })),
    getTerminalProcessIncarnation: vi.fn((handle: string) => `pty:${handle}:1`),
    closeTerminal: vi.fn(async (handle) => ({
      handle,
      tabId: 'tab',
      ptyKilled: true
    })),
    waitForTerminal: vi.fn(async (handle) => ({
      handle,
      condition: 'tui-idle' as const,
      satisfied: true,
      status: 'running' as const,
      exitCode: null
    })),
    listRoomRunningAgents: vi.fn(async (worktreeId) =>
      ROOM_HARNESS_AGENTS.map((agent) => ({
        agent,
        worktreeId,
        terminalHandle: `term_${agent}`,
        paneKey: `tab:${agent}`,
        title: agent,
        providerSession: {
          key: 'session_id' as const,
          id: `live-${agent}`
        }
      }))
    ),
    listRoomExistingAgents: vi.fn(async () => []),
    resolveRoomHistoricalSession: vi.fn(async (_worktreeId, agent, historyId) => ({
      key: 'session_id' as const,
      id: `session-${agent}`,
      transcriptPath: `/sessions/${historyId}.jsonl`
    })),
    stageRoomAttachment: vi.fn(
      async (worktreeId, _terminalHandle, attachment) =>
        `/worktrees/${worktreeId}/.orca/room-attachments/${attachment.id}`
    )
  }
}

it('registers the canonical idle wait before interrupting a room agent', async () => {
  const runtime = runtimeStub()
  const adapter = createRoomHarnessAdapters(runtime).codex
  const binding = {
    worktreeId: 'worktree-1',
    terminalHandle: 'term-codex',
    paneKey: 'tab:codex',
    providerSession: null
  }

  await adapter.interrupt(binding)

  expect(runtime.waitForTerminal).toHaveBeenCalledWith('term-codex', {
    condition: 'tui-idle',
    timeoutMs: 8_000,
    signal: expect.any(AbortSignal)
  })
  expect(runtime.sendTerminal).toHaveBeenCalledWith('term-codex', { text: '\x1b' })
  expect(vi.mocked(runtime.waitForTerminal).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(runtime.sendTerminal!).mock.invocationCallOrder[0]!
  )
})

it('accepts an idle transition while ESC is being written', async () => {
  const runtime = runtimeStub()
  let resolveIdle!: (value: Awaited<ReturnType<RoomHarnessRuntime['waitForTerminal']>>) => void
  runtime.waitForTerminal = vi.fn(
    () =>
      new Promise<Awaited<ReturnType<RoomHarnessRuntime['waitForTerminal']>>>((resolve) => {
        resolveIdle = resolve
      })
  )
  runtime.sendTerminal = vi.fn(async (handle, action) => {
    resolveIdle({
      handle,
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    })
    return { handle, accepted: true, bytesWritten: Buffer.byteLength(action.text ?? '') }
  })

  await createRoomHarnessAdapters(runtime).codex.interrupt({
    worktreeId: 'worktree-1',
    terminalHandle: 'term-codex',
    paneKey: 'tab:codex',
    providerSession: null
  })
})

it('accepts process exit while interrupting a room agent', async () => {
  const runtime = runtimeStub()
  let rejectIdle!: (error: Error) => void
  runtime.waitForTerminal = vi.fn(
    () =>
      new Promise<Awaited<ReturnType<RoomHarnessRuntime['waitForTerminal']>>>(
        (_resolve, reject) => {
          rejectIdle = reject
        }
      )
  )
  runtime.sendTerminal = vi.fn(async (handle, action) => {
    rejectIdle(new Error('terminal_exited'))
    return { handle, accepted: true, bytesWritten: Buffer.byteLength(action.text ?? '') }
  })

  await expect(
    createRoomHarnessAdapters(runtime).codex.interrupt({
      worktreeId: 'worktree-1',
      terminalHandle: 'term-codex',
      paneKey: 'tab:codex',
      providerSession: null
    })
  ).resolves.toBeUndefined()
})

it('rejects an interrupt that never reaches idle', async () => {
  const runtime = runtimeStub()
  vi.mocked(runtime.waitForTerminal)
    .mockResolvedValueOnce({
      handle: 'term-codex',
      condition: 'tui-idle',
      satisfied: false,
      status: 'running',
      exitCode: null,
      blockedReason: 'codex-interactive-prompt'
    })
    .mockRejectedValueOnce(new Error('timeout'))

  await expect(
    createRoomHarnessAdapters(runtime).codex.interrupt({
      worktreeId: 'worktree-1',
      terminalHandle: 'term-codex',
      paneKey: 'tab:codex',
      providerSession: null
    })
  ).rejects.toThrow('room_agent_not_ready')
})

describe.each(ROOM_HARNESS_AGENTS)('%s room harness adapter', (agent: RoomHarnessAgent) => {
  it('implements the shared PTY lifecycle without provider-specific transport', async () => {
    const runtime = runtimeStub()
    const adapter = createRoomHarnessAdapters(runtime)[agent]
    const launched = await adapter.launch('worktree-1')

    expect(launched).toMatchObject({
      worktreeId: 'worktree-1',
      terminalHandle: `term_${agent}`,
      paneKey: `tab:${agent}`,
      disposition: 'created'
    })
    expect(runtime.createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        agent,
        worktree: 'id:worktree-1',
        viewMode: 'chat',
        surfaceOwner: false,
        persistHostSessionBinding: false
      })
    )
    await expect(
      adapter.connectExisting({
        worktreeId: launched.worktreeId,
        terminalHandle: launched.terminalHandle,
        paneKey: launched.paneKey
      })
    ).resolves.toMatchObject({ disposition: 'adopted', terminalSurfaceVisible: true })
    await expect(adapter.send(launched, 'review')).resolves.toMatchObject({ accepted: true })
    await adapter.prepareControl?.(launched, '/fast off')
    if (agent === 'claude') {
      expect(runtime.sendTerminal).toHaveBeenCalledWith(launched.terminalHandle, { text: '\x1b' })
      expect(runtime.waitForTerminalAgentInputReady).toHaveBeenCalledWith(
        launched.terminalHandle,
        'claude'
      )
    } else {
      expect(runtime.sendTerminal).not.toHaveBeenCalled()
    }
    await expect(adapter.status(launched)).resolves.toMatchObject({ isRunningAgent: true })
    await expect(adapter.awaitReady(launched)).resolves.toMatchObject({ satisfied: true })
    expect(runtime.waitForTerminal).toHaveBeenCalledWith(`term_${agent}`, {
      condition: 'tui-idle'
    })
    await expect(adapter.compact(launched)).resolves.toMatchObject({ accepted: true })
    await expect(
      adapter.stageAttachment(launched, {
        id: 'attachment',
        fileName: 'evidence.txt',
        localPath: '/stored/evidence.txt'
      })
    ).resolves.toContain('/worktrees/worktree-1/')
    await expect(adapter.stop(launched)).resolves.toMatchObject({ ptyKilled: true })
    // Room-owned stops must bypass the view-close guard and really kill the PTY.
    expect(runtime.closeTerminal).toHaveBeenCalledWith(launched.terminalHandle, {
      force: true,
      waitForExit: true
    })

    const providerSession = {
      key: 'session_id' as const,
      id: `session-${agent}`,
      transcriptPath: `/sessions/history-${agent}.jsonl`
    }
    await expect(
      adapter.connectExisting({ worktreeId: 'worktree-1', historyId: `history-${agent}` })
    ).resolves.toMatchObject({ providerSession, disposition: 'adopted' })
    expect(runtime.ensureAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        agent,
        providerSession,
        worktree: 'id:worktree-1',
        surfaceOwner: false,
        persistHostSessionBinding: false
      })
    )
    await expect(adapter.restore({ ...launched, providerSession })).resolves.toMatchObject({
      providerSession,
      disposition: 'adopted'
    })
    await expect(
      adapter.reconfigure({ ...launched, providerSession }, { model: 'model-1', effort: 'high' })
    ).resolves.toMatchObject({ providerSession, disposition: 'created' })
    expect(runtime.ensureAgentSession).toHaveBeenLastCalledWith(
      expect.objectContaining({
        agent,
        providerSession,
        launchPreferences: { model: 'model-1', effort: 'high' }
      })
    )
  })

  it('rejects renderer-spoofed terminal identity at the host boundary', async () => {
    const runtime = runtimeStub()
    vi.mocked(runtime.listRoomRunningAgents).mockResolvedValue([])
    const adapter = createRoomHarnessAdapters(runtime)[agent]

    await expect(
      adapter.connectExisting({
        worktreeId: 'worktree-1',
        terminalHandle: `term_${agent}`,
        paneKey: `tab:${agent}`
      })
    ).rejects.toThrow('room_agent_not_running')
  })

  it('reattaches a live provider session after its pane identity changes', async () => {
    const runtime = runtimeStub()
    const providerSession = {
      key: 'session_id' as const,
      id: `session-${agent}`,
      transcriptPath: `/sessions/${agent}.jsonl`
    }
    vi.mocked(runtime.listRoomRunningAgents).mockResolvedValue([
      {
        agent,
        worktreeId: 'worktree-1',
        terminalHandle: 'term_live',
        paneKey: 'tab:new-pane',
        title: agent,
        providerSession
      }
    ])
    const adapter = createRoomHarnessAdapters(runtime)[agent]

    await expect(
      adapter.restore({
        worktreeId: 'worktree-1',
        terminalHandle: 'term_stale',
        paneKey: 'tab:stale-pane',
        providerSession
      })
    ).resolves.toMatchObject({
      terminalHandle: 'term_live',
      paneKey: 'tab:new-pane',
      disposition: 'adopted'
    })
    expect(runtime.ensureAgentSession).not.toHaveBeenCalled()
  })

  it.each([true, false])(
    'restores the participant in its stable pane with persisted surface=%s',
    async (persisted) => {
      const runtime = runtimeStub()
      const paneKey = 'room-tab:11111111-1111-4111-8111-111111111111'
      const providerSession = {
        key: 'session_id' as const,
        id: `session-${agent}`,
        transcriptPath: `/sessions/${agent}.jsonl`
      }
      vi.mocked(runtime.listRoomRunningAgents).mockResolvedValue([])
      runtime.hasPersistedTerminalSurface = vi.fn(() => persisted)
      const adapter = createRoomHarnessAdapters(runtime)[agent]

      await adapter.restore({
        worktreeId: 'worktree-1',
        terminalHandle: 'term-stale',
        paneKey,
        providerSession
      })

      expect(runtime.ensureAgentSession).toHaveBeenCalledWith(
        expect.objectContaining({
          placement: {
            tabId: 'room-tab',
            leafId: '11111111-1111-4111-8111-111111111111'
          },
          persistHostSessionBinding: persisted
        })
      )
    }
  )

  it('degrades read, subscribe, and context safely before session identity arrives', async () => {
    const adapter = createRoomHarnessAdapters(runtimeStub())[agent]
    const binding = await adapter.launch('worktree-1')

    await expect(adapter.read(binding)).resolves.toMatchObject({ notFound: true })
    await expect(adapter.context(binding, EMPTY_ROOM_CONTEXT)).resolves.toBe(EMPTY_ROOM_CONTEXT)
    const subscription = await adapter.subscribe(binding, {
      onSnapshot: () => {},
      onEvent: () => {},
      onOpaqueAppend: () => {}
    })
    expect(subscription.watching).toBe(false)
    expect(() => subscription.unsubscribe()).not.toThrow()
  })

  it('restarts a zero-turn session with new options without requiring resume metadata', async () => {
    const runtime = runtimeStub()
    const adapter = createRoomHarnessAdapters(runtime)[agent]
    const launched = await adapter.launch('worktree-1')

    await expect(
      adapter.reconfigure(launched, { model: 'model-2', effort: 'high' })
    ).resolves.toMatchObject({
      providerSession: null,
      disposition: 'created'
    })
    expect(runtime.createAgentSession).toHaveBeenLastCalledWith(
      expect.objectContaining({
        agent,
        worktree: 'id:worktree-1',
        viewMode: 'chat',
        launchPreferences: { model: 'model-2', effort: 'high' }
      })
    )
  })

  it('normalizes hook status into the shared room lifecycle', () => {
    const adapter = createRoomHarnessAdapters(runtimeStub())[agent]
    const activity = adapter.statusEvent({
      paneKey: `tab:${agent}`,
      connectionId: null,
      hookEventName: 'PreToolUse',
      receivedAt: 10,
      payload: {
        state: 'working',
        prompt: '',
        agentType: agent,
        toolName: 'Read',
        toolInput: 'src/app.ts'
      }
    })
    const final = adapter.statusEvent({
      paneKey: `tab:${agent}`,
      connectionId: null,
      hookEventName: 'Stop',
      receivedAt: 20,
      payload: {
        state: 'done',
        prompt: '',
        agentType: agent,
        lastAssistantMessage: 'Done.'
      }
    })
    const failed = adapter.statusEvent({
      paneKey: `tab:${agent}`,
      connectionId: null,
      hookEventName: 'StopFailure',
      receivedAt: 30,
      payload: { state: 'done', prompt: '', agentType: agent }
    })
    const interrupted = adapter.statusEvent({
      paneKey: `tab:${agent}`,
      connectionId: null,
      hookEventName: 'Stop',
      receivedAt: 40,
      payload: { state: 'done', prompt: '', agentType: agent, interrupted: true }
    })

    expect(activity).toMatchObject({
      type: 'activity',
      source: 'status',
      timestamp: 10,
      activity: { kind: 'reading', detail: 'src/app.ts' }
    })
    expect(final).toMatchObject({ type: 'final', text: 'Done.', timestamp: 20 })
    expect(failed).toMatchObject({ type: 'failed', timestamp: 30 })
    expect(interrupted).toMatchObject({ type: 'interrupted', timestamp: 40 })
  })
})

describe('room transcript lifecycle normalization', () => {
  it('keeps activity transient and emits explicit final and interruption boundaries', () => {
    const toolMessage = {
      id: 'tool-1',
      role: 'assistant' as const,
      blocks: [{ type: 'tool-call' as const, name: 'Bash', input: { command: 'git status' } }],
      timestamp: 10,
      source: 'transcript' as const
    }
    expect(transcriptLifecycleEvent([toolMessage])).toMatchObject({
      type: 'activity',
      activity: { kind: 'command', detail: 'git status' },
      messages: [toolMessage]
    })
    expect(
      transcriptLifecycleEvent([], { state: 'completed', turnId: 'turn-1', timestamp: 20 })
    ).toMatchObject({ type: 'final', turnId: 'turn-1' })
    expect(
      transcriptLifecycleEvent([], { state: 'interrupted', turnId: 'turn-2', timestamp: 30 })
    ).toMatchObject({ type: 'interrupted', turnId: 'turn-2' })
  })

  it('carries the real turn user prompt and skips tool-result and noise user rows', () => {
    const prompt = {
      id: 'user-1',
      role: 'user' as const,
      blocks: [{ type: 'text' as const, text: 'inspect the repository' }],
      timestamp: 5,
      source: 'transcript' as const
    }
    const toolResult = {
      id: 'user-2',
      role: 'user' as const,
      blocks: [{ type: 'tool-result' as const, output: 'ok' }],
      timestamp: 6,
      source: 'transcript' as const
    }
    const event = transcriptLifecycleEvent([prompt, toolResult])
    expect(event?.userMessage).toEqual({ id: 'user-1', text: 'inspect the repository' })
    expect(transcriptLifecycleEvent([toolResult])?.userMessage).toBeUndefined()
  })
})

describe('Codex room tool activity', () => {
  it('replaces one native tool operation with its completed result', () => {
    const adapter = createRoomHarnessAdapters(runtimeStub()).codex
    const input = { cmd: 'git status --short', workdir: '/repo' }
    const started = adapter.statusEvent({
      paneKey: 'tab:codex',
      connectionId: null,
      hookEventName: 'PreToolUse',
      toolUseId: 'call_native',
      toolActivity: { input },
      receivedAt: 10,
      payload: {
        state: 'working',
        prompt: '',
        agentType: 'codex',
        toolName: 'exec_command',
        toolInput: 'git status --short'
      }
    })
    const completed = adapter.statusEvent({
      paneKey: 'tab:codex',
      connectionId: null,
      hookEventName: 'PostToolUse',
      toolUseId: 'call_native',
      toolActivity: { input, output: 'clean' },
      receivedAt: 20,
      payload: {
        state: 'working',
        prompt: '',
        agentType: 'codex',
        toolName: 'exec_command',
        toolInput: 'git status --short'
      }
    })

    expect(started?.messages).toMatchObject([
      {
        id: 'hook:call_native',
        blocks: [{ type: 'tool-call', name: 'exec_command', input }]
      }
    ])
    expect(completed?.messages).toMatchObject([
      {
        id: 'hook:call_native',
        blocks: [
          { type: 'tool-call', name: 'exec_command', input },
          { type: 'tool-result', output: 'clean' }
        ]
      }
    ])
  })
})
