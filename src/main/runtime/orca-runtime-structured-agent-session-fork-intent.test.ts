import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../agent-workspace-trust', () => ({ applyAgentWorkspaceTrust: vi.fn(async () => ({})) }))

import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import type { AgentJournalRenderItem } from '../../shared/agent-session-journal-types'
import { codexProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import { attachFingerprintFields } from '../native-chat/agent-session-wire/structured-agent-session-attach'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { OrcaRuntimeService } from './orca-runtime'

const PARENT = 'codex_parent_chat'
const TURN = 'legacy:codex:parent:turn-lifecycle:turn-1'
const ANSWER = 'codex:thread-parent:turn-1:1'

afterEach(() => setStructuredAgentSessionHost(null))

function row(itemId: string, body: unknown, turnItemId?: string): AgentJournalRenderItem {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: resolving a fork reads only a row's id, body and turn scope.
  return {
    itemId,
    body,
    ...(turnItemId ? { turnScope: { kind: 'turn', turnItemId } } : {})
  } as AgentJournalRenderItem
}

/** A runtime whose host holds one Codex chat with one finished turn, in `workspaceId`. */
function runtimeHoldingParent(workspaceId: string, parent: Partial<AgentSessionRecord> = {}) {
  const location = { ...agentSessionRecordFixture().location, workspaceId }
  const record: AgentSessionRecord = {
    ...agentSessionRecordFixture(),
    sessionId: PARENT,
    provider: 'codex',
    location,
    accountHome: { variable: 'CODEX_HOME', path: '/accounts/parent/home' },
    options: { model: 'gpt-parent', effort: 'high' },
    providerHandleChain: [
      {
        linkId: 'link-1',
        origin: 'created',
        mintedAtFence: 7,
        observedAt: 1,
        handle: codexProviderHandle('thread-parent')
      }
    ],
    ...parent
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a forking create reads only the record store and one journal snapshot from the host.
  setStructuredAgentSessionHost({
    deps: {
      store: {
        getRecord: (id: string) => (id === PARENT ? record : null),
        listRecords: () => [record],
        listOperationRows: () => []
      }
    },
    journalItem: async (_sessionId: string, itemId: string) =>
      [
        row(TURN, { kind: 'turn', turnId: 'turn-1', state: 'completed', outcome: 'success' }),
        row(ANSWER, { kind: 'message', role: 'assistant', blocks: [] }, TURN)
      ].find((item) => item.itemId === itemId) ?? null
  } as unknown as StructuredAgentSessionHost)
  const prepareCodexStructuredLaunch = vi.fn(() => '/accounts/selected/home')
  const runtime = new OrcaRuntimeService(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: create intent only reads getSettings from the store.
    {
      getSettings: () => ({
        agentDefaultEnv: { codex: {} },
        nativeChatSessionOptions: { codex: { model: 'gpt-saved' } }
      })
    } as never,
    undefined,
    { prepareCodexStructuredLaunch }
  )
  vi.spyOn(runtime, 'getStructuredAgentSessionCreateSupport').mockResolvedValue({ supported: true })
  Object.assign(runtime, {
    resolveStructuredAgentSessionLocation: vi.fn(async () => location),
    resolveRuntimeFileTarget: vi.fn(async () => ({ worktree: { path: '/host/floating-now' } }))
  })
  const fork = () =>
    runtime.resolveStructuredAgentSessionCreateIntent({
      envelope: { sessionId: 'codex_forked_chat', clientOperationId: 'operation-1' },
      worktree: `id:${workspaceId}`,
      agent: 'codex',
      forkFrom: { sessionId: PARENT, itemId: ANSWER }
    })
  return { fork, prepareCodexStructuredLaunch }
}

describe('create intent for a fork', () => {
  it('starts the new chat as its parent: same account and selection, with the origin on its identity', async () => {
    const { fork, prepareCodexStructuredLaunch } = runtimeHoldingParent('workspace-1')

    const intent = await fork()

    const forkedFrom = {
      sessionId: PARENT,
      itemId: ANSWER,
      providerSessionId: 'thread-parent',
      forkPoint: 'turn-1'
    }
    expect(intent).toMatchObject({
      forkedFrom,
      // The parent's, not the account or model a fresh chat would pick today.
      accountHome: { variable: 'CODEX_HOME', path: '/accounts/parent/home' },
      options: { model: 'gpt-parent', effort: 'high' }
    })
    expect(prepareCodexStructuredLaunch).not.toHaveBeenCalled()
    // The provider copies when the new chat first starts, so nothing is adopted up front.
    expect(intent).not.toHaveProperty('adopt')
    // Part of which chat this create is: a retry replays, and a blank create never matches it.
    expect(attachFingerprintFields(intent).forkedFrom).toEqual(forkedFrom)
  })

  it('runs as a parent that never had a selection saved does, not on the default saved since', async () => {
    const { fork } = runtimeHoldingParent('workspace-1', { options: undefined })

    expect(await fork()).not.toHaveProperty('options')
  })

  it('keeps a floating parent’s folder, not wherever the floating setting points now', async () => {
    const { fork } = runtimeHoldingParent(FLOATING_TERMINAL_WORKTREE_ID, {
      launchDirectory: '/host/floating-when-parent-started'
    })

    expect((await fork()).hostLaunchDirectory).toBe('/host/floating-when-parent-started')
  })
})
