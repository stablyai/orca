import type { AgentJournalCursor } from '../../shared/agent-session-journal-types'
import type { StructuredReplyJournalSnapshot } from '../native-chat/agent-session-wire/structured-agent-session-reply-journal'
import { replySnapshotFixture } from './structured-reply-origin.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalRunFactsRegister } from '../runtime/terminal-run-facts'
import { getDefaultNotificationSettings } from '../../shared/notification-settings-defaults'
import type { EnrichedAgentHookEventPayload } from '../agent-hooks/server/server-types'
import { createAgentReplyEligibility } from './agent-reply-eligibility'
import { createReplyTranscriptFixture } from './claude-reply-origin.test-fixture'
import type * as ClaudeReplyOrigin from './claude-reply-origin'

const callbacks = vi.hoisted(() => {
  const listeners: {
    status?: (event: EnrichedAgentHookEventPayload) => void
    clear?: (event: { paneKey: string }) => void
  } = {}
  const chat: {
    enabled: boolean
    snapshot: StructuredReplyJournalSnapshot | null
    floors: Map<string, AgentJournalCursor>
  } = { enabled: false, snapshot: null, floors: new Map() }
  const chatHost = { replyJournal: { cursors: () => chat.floors, snapshot: () => chat.snapshot } }
  return {
    listeners,
    chat,
    chatHost,
    read: vi.fn<typeof ClaudeReplyOrigin.isClaudeHumanReply>()
  }
})
vi.mock('../agent-hooks/server', () => ({
  agentHookServer: {
    subscribeEnrichedStatus: (listener: NonNullable<typeof callbacks.listeners.status>) => {
      callbacks.listeners.status = listener
      return () => {
        delete callbacks.listeners.status
      }
    },
    subscribePaneStatusClear: (listener: NonNullable<typeof callbacks.listeners.clear>) => {
      callbacks.listeners.clear = listener
      return () => {
        delete callbacks.listeners.clear
      }
    }
  }
}))
vi.mock('../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => (callbacks.chat.enabled ? callbacks.chatHost : null)
}))
vi.mock('./claude-reply-origin', async (importOriginal) => {
  const original = await importOriginal<typeof ClaudeReplyOrigin>()
  callbacks.read.mockImplementation(original.isClaudeHumanReply)
  return { isClaudeHumanReply: callbacks.read }
})
const { transcript, dispose } = createReplyTranscriptFixture()
const disposals: (() => void)[] = []
afterEach(async () => {
  disposals.splice(0).forEach((dispose) => dispose())
  await dispose()
  callbacks.read.mockClear()
  callbacks.chat.enabled = false
  callbacks.chat.snapshot = null
  callbacks.chat.floors = new Map()
})

function rig(
  source: 'claude' | 'codex' = 'codex',
  enabled = true,
  transcriptPath = '/invented/transcript.jsonl'
) {
  const facts = new TerminalRunFactsRegister()
  const settings = { ...getDefaultNotificationSettings(), bringToFrontOnAgentTaskComplete: enabled }
  let settingsChanged: () => void = () => undefined
  const store = {
    getSettings: () => ({ notifications: settings }),
    onSettingsChanged: (listener: () => void) => {
      settingsChanged = listener
      return () => undefined
    }
  }
  const policy = createAgentReplyEligibility(
    store,
    {
      terminalRunFacts: facts,
      resolveTerminalPane: () => ({
        handle: 'handle',
        tabId: 'tab',
        leafId: 'leaf',
        ptyId: 'pty',
        connected: true,
        executionHostId: 'local'
      })
    },
    'darwin'
  )
  disposals.push(policy.dispose)
  const hook = (hookEventName: string, promptId = 'turn-A', sessionless = false) =>
    callbacks.listeners.status?.({
      paneKey: 'pane',
      connectionId: null,
      source,
      hookEventName,
      providerPromptId: promptId,
      providerSession: sessionless
        ? undefined
        : {
            key: 'session_id',
            id: 'session',
            transcriptPath
          },
      payload: { state: hookEventName === 'Stop' ? 'done' : 'working', prompt: 'invented' },
      receivedAt: 1,
      stateStartedAt: 1
    })
  const input = (origin: 'human' | 'programmatic', data = '\r') =>
    facts.recordInput('pty', 'driving', data, undefined, origin)
  // The renderer's request carries no turn identity; the host's own hook turn decides.
  const request = { source: 'agent-task-complete' as const, paneKey: 'pane' }
  return { facts, policy, hook, input, request, settings, settingsChanged: () => settingsChanged() }
}

describe('host reply eligibility and asynchronous invalidation', () => {
  it('Codex completion never reads a transcript, and is judged on the latest main turn', async () => {
    const r = rig()
    r.input('human')
    r.hook('UserPromptSubmit')
    r.hook('Stop')
    expect(await r.policy.canBring(r.request)).toBe(true)
    expect(r.policy.stillEligible(r.request)).toBe(true)
    expect(callbacks.read).not.toHaveBeenCalled()
    r.input('programmatic')
    r.hook('UserPromptSubmit', 'turn-B')
    expect(r.policy.stillEligible(r.request)).toBe(false)
    expect(await r.policy.canBring(r.request)).toBe(false)
    // A late request for the human turn cannot borrow its verdict once a program turn has ended.
    r.hook('Stop', 'turn-B')
    expect(await r.policy.canBring(r.request)).toBe(false)
  })
  it('Claude reads only after a human submission and rejects a new turn during that read', async () => {
    const r = rig('claude')
    r.input('programmatic')
    r.hook('UserPromptSubmit')
    r.hook('Stop')
    expect(await r.policy.canBring(r.request)).toBe(false)
    expect(callbacks.read).not.toHaveBeenCalled()
    r.input('human')
    r.hook('UserPromptSubmit')
    r.hook('Stop')
    const waiting = Promise.withResolvers<boolean>()
    callbacks.read.mockReturnValueOnce(waiting.promise)
    const verdict = r.policy.canBring(r.request)
    r.hook('UserPromptSubmit', 'turn-B')
    waiting.resolve(true)
    expect(await verdict).toBe(false)
    expect(r.policy.stillEligible(r.request)).toBe(false)
  })
  it('a sessionless working hook invalidates a pending Claude completion read', async () => {
    const r = rig('claude')
    r.input('human')
    r.hook('UserPromptSubmit')
    r.hook('Stop')
    const waiting = Promise.withResolvers<boolean>()
    callbacks.read.mockReturnValueOnce(waiting.promise)
    const verdict = r.policy.canBring(r.request)
    r.hook('PreToolUse', 'turn-A', true)
    waiting.resolve(true)
    expect(await verdict).toBe(false)
    expect(r.policy.stillEligible(r.request)).toBe(false)
  })
  it('S12: off-to-on starts an empty submission epoch; no transcript read while off', async () => {
    const r = rig('claude', false)
    r.input('human')
    r.hook('UserPromptSubmit')
    r.hook('Stop')
    expect(await r.policy.canBring(r.request)).toBe(false)
    r.settings.bringToFrontOnAgentTaskComplete = true
    r.settingsChanged()
    r.hook('Stop')
    expect(await r.policy.canBring(r.request)).toBe(false)
    expect(callbacks.read).not.toHaveBeenCalled()
  })
  it('clears a pending verdict on pane teardown and setting disable/re-enable', async () => {
    const r = rig()
    r.input('human')
    r.hook('UserPromptSubmit')
    r.hook('Stop')
    expect(await r.policy.canBring(r.request)).toBe(true)
    callbacks.listeners.clear?.({ paneKey: 'pane' })
    expect(r.policy.stillEligible(r.request)).toBe(false)
    r.input('human')
    r.hook('UserPromptSubmit')
    r.hook('Stop')
    expect(await r.policy.canBring(r.request)).toBe(true)
    r.settings.bringToFrontOnAgentTaskComplete = false
    r.settingsChanged()
    r.settings.bringToFrontOnAgentTaskComplete = true
    r.settingsChanged()
    expect(r.policy.stillEligible(r.request)).toBe(false)
  })
})

describe('uninterrupted terminal refusal scenarios', () => {
  it.each(['claude', 'codex'] as const)(
    'S17/S7: %s program submissions stay program-authored after a local /status Enter',
    async (source) => {
      const path = await transcript([
        { type: 'user', promptId: 'turn-A', origin: { kind: 'human' } },
        { type: 'user', promptId: 'turn-B', origin: { kind: 'human' } },
        { type: 'user', promptId: 'turn-C', origin: { kind: 'human' } }
      ])
      const r = rig(source, true, path)
      r.input('programmatic', 'worker instruction\r')
      r.hook('UserPromptSubmit')
      r.hook('Stop')
      expect(await r.policy.canBring(r.request)).toBe(false)
      r.input('human', '/status\r')
      r.input('programmatic', 'message after status\r')
      r.hook('UserPromptSubmit', 'turn-B')
      r.hook('Stop', 'turn-B')
      expect(await r.policy.canBring(r.request)).toBe(false)
      expect(callbacks.read).not.toHaveBeenCalled()
      r.input('human')
      r.hook('UserPromptSubmit', 'turn-C')
      r.hook('Stop', 'turn-C')
      expect(await r.policy.canBring(r.request)).toBe(true)
    }
  )

  it.each(['claude', 'codex'] as const)(
    'S16: %s refuses a program completion and the wake after a human approval Enter',
    async (source) => {
      const path = await transcript([
        { type: 'user', promptId: 'turn-A', origin: { kind: 'human' } },
        {
          type: 'user',
          promptId: 'wake',
          origin: { kind: 'task-notification' },
          message: { role: 'user', content: '<task-notification>job finished</task-notification>' }
        },
        { type: 'assistant', promptId: 'wake', message: { role: 'assistant', content: 'Done' } },
        { type: 'user', promptId: 'turn-C', origin: { kind: 'human' } }
      ])
      const r = rig(source, true, path)
      r.input('programmatic', 'program turn needing approval\r')
      r.hook('UserPromptSubmit')
      r.input('human')
      r.hook('Stop')
      expect(await r.policy.canBring(r.request)).toBe(false)
      expect(callbacks.read).not.toHaveBeenCalled()
      r.hook(source === 'claude' ? 'UserPromptSubmit' : 'PreToolUse', 'wake')
      r.hook('Stop', 'wake')
      expect(await r.policy.canBring(r.request)).toBe(false)
      if (source === 'claude') {
        expect(callbacks.read).toHaveBeenCalledExactlyOnceWith(
          path,
          'wake',
          expect.any(AbortSignal)
        )
      } else {
        expect(callbacks.read).not.toHaveBeenCalled()
      }
      r.input('human')
      r.hook('UserPromptSubmit', 'turn-C')
      r.hook('Stop', 'turn-C')
      expect(await r.policy.canBring(r.request)).toBe(true)
    }
  )

  it.each(['claude', 'codex'] as const)(
    'S4: %s wake cannot reuse a completed human submission',
    async (source) => {
      const path = await transcript([
        { type: 'user', promptId: 'turn-A', origin: { kind: 'human' } },
        { type: 'user', promptId: 'wake', origin: { kind: 'human' } }
      ])
      const r = rig(source, true, path)
      r.input('human')
      r.hook('UserPromptSubmit')
      r.hook('Stop')
      expect(await r.policy.canBring(r.request)).toBe(true)
      callbacks.read.mockClear()
      r.hook(source === 'claude' ? 'UserPromptSubmit' : 'PreToolUse', 'wake')
      r.hook('Stop', 'wake')
      expect(await r.policy.canBring(r.request)).toBe(false)
      expect(callbacks.read).not.toHaveBeenCalled()
    }
  )
})

describe('structured chat submission epochs', () => {
  it('accepts the exact live user turn, but rejects a previous journal epoch or enable cursor', async () => {
    callbacks.chat.enabled = true
    callbacks.chat.snapshot = replySnapshotFixture('user')
    const r = rig()
    const request = {
      ...r.request,
      surface: 'agent-session' as const,
      structuredOrigin: {
        scope: {
          executionHostId: 'local' as const,
          wslDistro: null,
          workspaceId: 'workspace',
          workspaceKind: 'folder' as const
        },
        sessionId: 'chat',
        cause: { kind: 'completion' as const, requestId: 'turn-A' },
        journalCursor: { epoch: 'epoch', sequence: 3 }
      }
    }
    expect(await r.policy.canBring(request)).toBe(true)
    expect(r.policy.stillEligible(request)).toBe(true)
    callbacks.chat.snapshot.items.push({
      itemId: 'later-turn',
      revision: 1,
      sequence: 4,
      observedAt: 2,
      body: { kind: 'turn', turnId: 'turn-B', state: 'running' }
    })
    expect(r.policy.stillEligible(request)).toBe(false)
    callbacks.chat.snapshot = replySnapshotFixture('user')
    expect(await r.policy.canBring(request)).toBe(true)
    callbacks.chat.snapshot = null
    expect(r.policy.stillEligible(request)).toBe(false)
    callbacks.chat.snapshot = replySnapshotFixture('user')
    expect(
      await r.policy.canBring({
        ...request,
        structuredOrigin: {
          ...request.structuredOrigin,
          journalCursor: { epoch: 'old-epoch', sequence: 3 }
        }
      })
    ).toBe(false)
    r.settings.bringToFrontOnAgentTaskComplete = false
    r.settingsChanged()
    callbacks.chat.floors.set('chat', { epoch: 'epoch', sequence: 3 })
    r.settings.bringToFrontOnAgentTaskComplete = true
    r.settingsChanged()
    expect(await r.policy.canBring(request)).toBe(false)
    expect(callbacks.read).not.toHaveBeenCalled()
  })
})
