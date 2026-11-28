import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status/contracts/agent-status-ipc-payload'
import {
  AgentSessionRefusalError,
  type AgentSessionWireRefusal
} from '../../../shared/agent-session/failures/agent-session-wire-refusals'
import { setStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import {
  agentPromptResultFromRefusal,
  chatPromptMutation,
  createAgentPromptDirectory,
  type AgentPromptRuntime
} from './agent-prompt-sources'

const SSH_PANE = 'ssh-pane'
const FOLDER_PANE = 'folder-pane'
const SHELL_PANE = 'shell-pane'
const SSH_PROMPT = 'term:pty:ssh:1:26bea7ae07aef52f093a'
const FOLDER_PROMPT = 'term:folder-pty:bdb13313988be0581b7b'
const APPROVAL_JSON = JSON.stringify({ approval: { tool: 'Bash', summary: 'ls' } })

function row(input: {
  paneKey: string
  connectionId: string | null
  worktreeId: string
  agentType: string
  stateStartedAt: number
}): AgentStatusIpcPayload {
  return {
    state: 'waiting',
    prompt: '',
    agentType: input.agentType,
    paneKey: input.paneKey,
    connectionId: input.connectionId,
    worktreeId: input.worktreeId,
    receivedAt: input.stateStartedAt,
    stateStartedAt: input.stateStartedAt,
    interactivePrompt: APPROVAL_JSON
  }
}

function terminalRuntime(): {
  runtime: AgentPromptRuntime
  keys: string[]
  sends: number
  rows: Map<string, AgentStatusIpcPayload>
  beforeWrite: (() => void) | null
} {
  const rows = new Map<string, AgentStatusIpcPayload>([
    [
      SSH_PANE,
      row({
        paneKey: SSH_PANE,
        connectionId: 'ssh-1',
        worktreeId: 'repo::feature',
        agentType: 'claude',
        stateStartedAt: 50
      })
    ],
    [
      FOLDER_PANE,
      row({
        paneKey: FOLDER_PANE,
        connectionId: null,
        worktreeId: 'folder-notes',
        agentType: 'claude',
        stateStartedAt: 60
      })
    ],
    [
      SHELL_PANE,
      row({
        paneKey: SHELL_PANE,
        connectionId: null,
        worktreeId: 'folder-notes',
        agentType: 'shell',
        stateStartedAt: 70
      })
    ]
  ])
  const keys: string[] = []
  const state: { sends: number; beforeWrite: (() => void) | null } = { sends: 0, beforeWrite: null }
  const runtime = {
    agentTransitions: {
      trackedPanes: () => [
        { paneKey: SSH_PANE, worktreeId: 'ignored-ssh' },
        { paneKey: FOLDER_PANE, worktreeId: 'ignored-folder' },
        { paneKey: SHELL_PANE, worktreeId: 'folder-notes' }
      ],
      latestRow: (paneKey: string) => rows.get(paneKey) ?? null
    },
    getTerminalHandleForPaneKey: (paneKey: string) =>
      paneKey === SSH_PANE ? 'term-ssh' : paneKey === FOLDER_PANE ? 'term-folder' : 'term-shell',
    getTerminalPromptRequestBinding: (handle: string) => {
      if (handle === 'term-ssh') {
        return { ptyId: 'pty:ssh:1', processIncarnation: 'inc-9' }
      }
      if (handle === 'term-folder') {
        return { ptyId: 'folder-pty', processIncarnation: 'inc-1' }
      }
      return { ptyId: 'shell-pty', processIncarnation: 'inc-shell' }
    },
    sendTerminal: vi.fn(
      async (
        handle: string,
        action: { text?: string },
        options: {
          reserveWrite?: (ptyId: string) => void
        }
      ) => {
        state.sends += 1
        state.beforeWrite?.()
        const ptyId = handle === 'term-ssh' ? 'pty:ssh:1' : 'folder-pty'
        options.reserveWrite?.(ptyId)
        keys.push(action.text ?? '')
        return {
          handle,
          accepted: true,
          bytesWritten: 1,
          writeSettlement: { outcome: 'accepted' as const }
        }
      }
    )
  }
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake runtime implements the pane, handle, and send methods this test calls.
    runtime: runtime as unknown as AgentPromptRuntime,
    keys,
    get sends() {
      return state.sends
    },
    rows,
    set beforeWrite(value: (() => void) | null) {
      state.beforeWrite = value
    },
    get beforeWrite() {
      return state.beforeWrite
    }
  }
}

afterEach(() => {
  setStructuredAgentSessionHost(null)
})

type ChatPromptHostFake = {
  loadedSessionIds: () => readonly string[]
  publishedWork: (sessionId: string) => { actionablePrompts: readonly unknown[] } | undefined
  deps: { store: { getConversation: (sessionId: string) => unknown } }
  respondToPrompt: (caller: unknown, params: unknown) => Promise<unknown>
}

function installChatPromptHost(host: ChatPromptHostFake): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: chat listing only calls loadedSessionIds, publishedWork, deps, and respondToPrompt.
  setStructuredAgentSessionHost(host as never)
}

describe('agent prompt sources', () => {
  it('lists an ssh pane and a folder pane and skips an agent without a transcript', () => {
    const harness = terminalRuntime()
    const prompts = createAgentPromptDirectory(harness.runtime).list()
    expect(prompts.map((prompt) => prompt.promptId)).toEqual([SSH_PROMPT, FOLDER_PROMPT])
    expect(prompts.map((prompt) => prompt.worktreeId)).toEqual(['repo::feature', 'folder-notes'])
    expect(prompts.map((prompt) => prompt.target)).toEqual([
      { type: 'terminal', terminal: 'term-ssh' },
      { type: 'terminal', terminal: 'term-folder' }
    ])
    expect(prompts[0]).toMatchObject({
      kind: 'permission',
      agent: 'claude',
      title: 'Bash',
      detail: 'Bash: ls',
      createdAt: 50,
      options: [
        { optionId: 'allow_once', label: 'Allow once', role: 'approve' },
        { optionId: 'reject_once', label: 'Reject', role: 'deny' }
      ]
    })
  })

  it('sends the approval key once and refuses a second answer', async () => {
    const harness = terminalRuntime()
    const directory = createAgentPromptDirectory(harness.runtime)
    const prompt = directory.list().find((item) => item.promptId === SSH_PROMPT)
    expect(prompt).toBeDefined()
    expect(await directory.apply(prompt!, 'allow_once', 'op-1', 'phone-1')).toEqual({ ok: true })
    expect(harness.keys).toEqual(['1'])
    expect(await directory.apply(prompt!, 'allow_once', 'op-2', 'phone-1')).toEqual({
      ok: false,
      reason: 'stale'
    })
    expect(harness.keys).toEqual(['1'])
    expect(harness.sends).toBe(1)
  })

  it('does not send keys when the prompt changed before the answer', async () => {
    const harness = terminalRuntime()
    const directory = createAgentPromptDirectory(harness.runtime)
    const prompt = directory.list().find((item) => item.promptId === SSH_PROMPT)!
    harness.rows.get(SSH_PANE)!.interactivePrompt = JSON.stringify({
      approval: { tool: 'Bash', summary: 'rm' }
    })
    expect(await directory.apply(prompt, 'allow_once', 'op-1', 'phone-1')).toEqual({
      ok: false,
      reason: 'stale'
    })
    expect(harness.sends).toBe(0)
    expect(harness.keys).toEqual([])
  })

  it('does not send keys when the prompt changes during the write', async () => {
    const harness = terminalRuntime()
    const directory = createAgentPromptDirectory(harness.runtime)
    const prompt = directory.list().find((item) => item.promptId === SSH_PROMPT)!
    harness.beforeWrite = () => {
      harness.rows.get(SSH_PANE)!.stateStartedAt = 99
    }
    expect(await directory.apply(prompt, 'allow_once', 'op-1', 'phone-1')).toEqual({
      ok: false,
      reason: 'stale'
    })
    expect(harness.keys).toEqual([])
  })

  it('fingerprints a chat approval answer and maps host refusals', () => {
    const mutation = chatPromptMutation({
      sessionId: 'session01',
      itemId: 'item:1',
      revision: 4,
      kind: 'approval',
      optionId: 'allow',
      clientOperationId: 'op-1'
    })
    expect(mutation.envelope).toEqual({
      sessionId: 'session01',
      clientOperationId: 'op-1',
      expectedRuntimeFence: null,
      payloadFingerprint: 'e72acaf84c5308ac72932f7094458a01ecd774bce7723fbe2bcac3435ae29121'
    })
    expect(mutation.request).toEqual({
      itemId: 'item:1',
      expectedRevision: 4,
      kind: 'approval',
      optionId: 'allow'
    })
    expect(agentPromptResultFromRefusal('agent_session_item_revision_stale')).toEqual({
      ok: false,
      reason: 'stale'
    })
    expect(agentPromptResultFromRefusal('agent_session_already_resolved')).toEqual({
      ok: false,
      reason: 'stale'
    })
    expect(agentPromptResultFromRefusal('agent_session_checkpoint_stale')).toEqual({
      ok: false,
      reason: 'stale'
    })
    expect(agentPromptResultFromRefusal('agent_session_operation_invalid')).toEqual({
      ok: false,
      reason: 'rejected'
    })
    expect(agentPromptResultFromRefusal('agent_session_operation_conflict')).toEqual({
      ok: false,
      reason: 'rejected'
    })
    expect(agentPromptResultFromRefusal('agent_session_conflict')).toEqual({
      ok: false,
      reason: 'rejected'
    })
    expect(agentPromptResultFromRefusal('agent_session_operation_unknown')).toEqual({
      ok: false,
      reason: 'not_found'
    })
    expect(agentPromptResultFromRefusal('agent_session_journal_unreadable')).toEqual({
      ok: false,
      reason: 'unavailable'
    })
    expect(agentPromptResultFromRefusal('structured_agent_session_unsupported')).toEqual({
      ok: false,
      reason: 'unavailable'
    })
  })

  it('answers a loaded folder chat and reports a stale revision separately from a missing session', async () => {
    const seen: unknown[] = []
    installChatPromptHost({
      loadedSessionIds: () => ['session01', 'session02'],
      publishedWork: (sessionId: string) =>
        sessionId === 'session01'
          ? {
              actionablePrompts: [
                {
                  itemId: 'item:1',
                  revision: 4,
                  observedAt: 80,
                  body: {
                    kind: 'approval',
                    title: 'Run Bash',
                    displayName: 'Bash',
                    detail: 'ls',
                    options: [
                      { id: 'allow', label: 'Allow' },
                      { id: 'reject_once', label: 'Reject' }
                    ],
                    resolution: {
                      state: 'pending',
                      selectedOptionId: null,
                      resolvedBy: null,
                      resolvedAt: null
                    }
                  }
                }
              ]
            }
          : undefined,
      deps: {
        store: {
          getConversation: (sessionId: string) => {
            if (sessionId === 'session02') {
              throw new Error('unreadable')
            }
            if (sessionId === 'session01') {
              return { location: { workspaceId: 'folder-notes' }, provider: 'claude' }
            }
            return null
          }
        }
      },
      respondToPrompt: async (_caller: unknown, params: unknown) => {
        seen.push(params)
        return { ok: true, replayed: false, fence: 1, cursor: 1, value: null }
      }
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake runtime implements the pane, handle, and send methods this test calls.
    const directory = createAgentPromptDirectory({
      agentTransitions: { trackedPanes: () => [], latestRow: () => null },
      getTerminalHandleForPaneKey: () => null,
      getTerminalPromptRequestBinding: () => {
        throw new Error('no pty')
      },
      sendTerminal: vi.fn()
    } as unknown as AgentPromptRuntime)
    const prompts = directory.list()
    expect(prompts.map((prompt) => prompt.promptId)).toEqual(['chat:session01:item:1:4'])
    expect(prompts[0]).toMatchObject({
      worktreeId: 'folder-notes',
      agent: 'claude',
      kind: 'permission'
    })
    expect(await directory.apply(prompts[0]!, 'allow', 'op-1', 'phone-1')).toEqual({ ok: true })
    expect(seen).toEqual([
      {
        itemId: 'item:1',
        expectedRevision: 4,
        kind: 'approval',
        optionId: 'allow',
        envelope: {
          sessionId: 'session01',
          clientOperationId: 'op-1',
          expectedRuntimeFence: null,
          payloadFingerprint: 'e72acaf84c5308ac72932f7094458a01ecd774bce7723fbe2bcac3435ae29121'
        }
      }
    ])
    expect(directory.targetExists('chat:session01:item:1:3')).toBe(true)
    expect(directory.targetExists('chat:session09:item:1:1')).toBe(false)
  })

  it('maps a thrown session refusal to stale', async () => {
    installChatPromptHost({
      loadedSessionIds: () => ['session01'],
      publishedWork: () => ({
        actionablePrompts: [
          {
            itemId: 'item:1',
            revision: 4,
            observedAt: 80,
            body: {
              kind: 'approval',
              title: 'Run Bash',
              displayName: 'Bash',
              detail: 'ls',
              options: [{ id: 'allow', label: 'Allow' }],
              resolution: {
                state: 'pending',
                selectedOptionId: null,
                resolvedBy: null,
                resolvedAt: null
              }
            }
          }
        ]
      }),
      deps: {
        store: {
          getConversation: () => ({
            location: { workspaceId: 'folder-notes' },
            provider: 'claude'
          })
        }
      },
      respondToPrompt: async () => {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mapper reads only the refusal code.
        throw new AgentSessionRefusalError({
          code: 'agent_session_item_revision_stale'
        } as AgentSessionWireRefusal)
      }
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake runtime implements the pane, handle, and send methods this test calls.
    const directory = createAgentPromptDirectory({
      agentTransitions: { trackedPanes: () => [], latestRow: () => null },
      getTerminalHandleForPaneKey: () => null,
      getTerminalPromptRequestBinding: () => {
        throw new Error('no pty')
      },
      sendTerminal: vi.fn()
    } as unknown as AgentPromptRuntime)
    const prompt = directory.list()[0]!
    expect(await directory.apply(prompt, 'allow', 'op-9', 'phone-1')).toEqual({
      ok: false,
      reason: 'stale'
    })
  })
})
