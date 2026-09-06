import { createHash, randomUUID } from 'node:crypto'
import { vi } from 'vitest'
import { CanvasAgentContextStore } from '../../../shared/canvas-agent-context-store'
import type { CanvasContextBinding } from '../../../shared/canvas-agent-context'
import type { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationDb } from '../orchestration/db'
import { CanvasMessageJournal } from './canvas-message-journal'
import { CanvasMessageMembership } from './canvas-message-membership'
import { CanvasMessagingService } from './canvas-messaging-service'

export async function canvasMessagingFixture(
  provider: CanvasContextBinding['provider'] = 'codex',
  options: {
    contexts?: CanvasAgentContextStore
    panes?: Record<string, string>
  } = {}
) {
  const contexts = options.contexts ?? new CanvasAgentContextStore()
  const paneFor = (id: string) => options.panes?.[id] ?? id
  const nodeFor = (pane: string) =>
    Object.entries(options.panes ?? {}).find(([, value]) => value === pane)?.[0] ?? pane
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  let bindings: CanvasContextBinding[] = ['a', 'b'].map((id) => ({
    nodeId: id,
    paneKey: paneFor(id),
    name: `Agent ${id}`,
    worktreeId: 'folder-workspace',
    ptyId: `pty-${id}`,
    provider,
    notes: [],
    peers: [id === 'a' ? 'b' : 'a']
  }))
  const identities = new Map(
    bindings.map((member) => [
      member.nodeId,
      { sessionId: `session-${member.nodeId}`, launchTokenHash: hash(member.nodeId) }
    ])
  )
  let revision = 0
  const replace = async (change: (value: CanvasContextBinding[]) => CanvasContextBinding[]) => {
    bindings = change(bindings)
    await contexts.replace({ canvasId: 'canvas', revision: ++revision, bindings }, identities)
  }
  await replace((value) => value)
  for (const member of bindings) {
    await contexts.response(
      provider,
      {
        paneKey: member.paneKey,
        worktreeId: member.worktreeId,
        connectionId: null,
        launchToken: member.nodeId,
        hookEventName: 'UserPromptSubmit',
        providerSession: { key: 'session_id', id: `session-${member.nodeId}` },
        payload: { state: 'working', prompt: 'Review the task' }
      },
      {}
    )
  }
  const runtime = {
    getClientSettings: vi.fn(() => ({
      agentStatusHooksEnabled: true,
      disabledTuiAgents: [] as string[]
    })),
    resolveTerminalPane: vi.fn((pane: string) => ({
      handle: pane,
      ptyId: `pty-${nodeFor(pane)}`,
      executionHostId: 'local'
    })),
    resolveLiveLeafForHandle: vi.fn((pane: string) => ({ ptyId: `pty-${nodeFor(pane)}` })),
    getOrchestrationDispatchAuthority: vi.fn((pane: string) => ({
      launchTokenHash: hash(nodeFor(pane))
    })),
    getTerminalAgentStatus: vi.fn(async () => ({ isRunningAgent: true, status: 'working' })),
    readTerminal: vi.fn(async () => ({ source: 'screen', draft: '', composerReady: true })),
    sendTerminalAgentPrompt: vi.fn(
      async (
        _handle: string,
        _prompt: string,
        options: { beforeWrite?: (ptyId: string) => Promise<void> }
      ) => {
        await options.beforeWrite?.('pty-b')
        await options.beforeWrite?.('pty-b')
      }
    )
  }
  const db = new OrchestrationDb(':memory:')
  const journal = new CanvasMessageJournal(db)
  const host = runtime as unknown as OrcaRuntimeService
  const membership = new CanvasMessageMembership(contexts, host)
  const service = new CanvasMessagingService(journal, membership, host, () => '/verified/orca-dev')
  const input = () => ({
    paneKey: paneFor('a'),
    launchToken: 'a',
    canvasId: 'canvas',
    to: 'b',
    body: 'What is the API contract?',
    kind: 'question' as const,
    requestId: randomUUID()
  })
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve))
  return { contexts, runtime, db, journal, membership, service, input, replace, settle }
}
