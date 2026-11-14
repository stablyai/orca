import { vi } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { agentSessionRecordFixture } from '../../../testing/agent-session-record-test-fixture'
import {
  claudeProviderHandle,
  codexProviderHandle
} from '../../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { agentJournalItemKey } from '../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalSnapshot } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { prepareStructuredAgentSessionFork } from '../structured-agent-session-fork'
import type { StructuredAgentSessionHost } from '../../host/structured-agent-session-host'
import type { StructuredAgentSessionAdapter } from '../../providers/structured-agent-session-adapter'
import type { RestTestRig } from '../../host/testing/structured-agent-session-rest-test-rig'
import { structuredAgentSessionCreateParams } from '../../../../../shared/agent-session/structured-agent-session-create'

const SOURCE = '019e6b26-18e2-7103-b7a0-7ba6bb071123'
const COPY = '019e6b26-18e2-7103-b7a0-7ba6bb071124'

export function forkTestSource(rig: RestTestRig, agent: 'claude' | 'codex' = 'codex') {
  let admissions = 0
  let capability: 'checkpoint' | 'tip' = 'checkpoint'
  const record = agentSessionRecordFixture({
    sessionId: 'source-chat',
    provider: agent,
    accountHome: {
      variable: agent === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME',
      path: join(rig.root, 'source-account')
    },
    options: { model: 'retired-model', effort: 'high', fastMode: 'false' },
    permissionMode: 'accept-edits',
    launchArgs: ['--no-daemon'],
    launchDirectory: rig.root,
    providerHandleChain: [
      {
        linkId: 'source-head',
        origin: 'created',
        mintedAtFence: 1,
        observedAt: 1,
        handle:
          agent === 'claude' ? claudeProviderHandle(SOURCE, 'answer') : codexProviderHandle(SOURCE)
      }
    ]
  })
  const snapshot: AgentJournalSnapshot = {
    sessionId: record.sessionId,
    cursor: { epoch: 'source-epoch', sequence: 5 },
    submissions: [],
    items: [
      {
        itemId: agentJournalItemKey({
          provider: 'codex',
          threadId: SOURCE,
          turnId: 'completed-turn',
          ordinal: 0
        }),
        sequence: 1,
        revision: 1,
        observedAt: 1,
        body: {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: 'Remember the nonce 57319' }]
        }
      },
      {
        itemId: 'legacy:codex:source:ended-root',
        sequence: 2,
        revision: 1,
        observedAt: 2,
        body: { kind: 'turn', turnId: 'completed-turn', state: 'completed' }
      },
      {
        itemId: 'legacy:codex:source:selected-response',
        sequence: 3,
        revision: 1,
        observedAt: 3,
        turnScope: { kind: 'turn', turnItemId: 'legacy:codex:source:ended-root' },
        body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Remembered' }] }
      },
      {
        itemId: 'legacy:codex:source:running-root',
        sequence: 3,
        revision: 1,
        observedAt: 3,
        body: { kind: 'turn', turnId: 'active-turn', state: 'running' }
      },
      {
        itemId: 'legacy:codex:source:ended-child',
        sequence: 4,
        revision: 1,
        observedAt: 4,
        agentId: 'child',
        body: { kind: 'turn', turnId: 'child-turn', state: 'completed' }
      }
    ]
  }
  const copy = vi.fn(
    async (
      _input: Parameters<NonNullable<StructuredAgentSessionAdapter['copyConversation']>>[0]
    ): ReturnType<NonNullable<StructuredAgentSessionAdapter['copyConversation']>> => {
      const dir =
        agent === 'claude'
          ? join(rig.root, 'source-account', 'projects', 'workspace')
          : join(rig.root, 'source-account', 'sessions', '2026', '11', '03')
      await mkdir(dir, { recursive: true })
      const filePath = join(
        dir,
        agent === 'claude' ? `${COPY}.jsonl` : `rollout-2026-11-03T19-00-00-${COPY}.jsonl`
      )
      if (agent === 'claude') {
        await writeFile(
          filePath,
          `${[
            {
              type: 'user',
              uuid: 'prompt',
              parentUuid: null,
              sessionId: COPY,
              timestamp: '2026-11-03T19:00:00.000Z',
              cwd: rig.root,
              message: { role: 'user', content: 'Remember the nonce 57319' }
            },
            {
              type: 'assistant',
              uuid: 'answer',
              parentUuid: 'prompt',
              sessionId: COPY,
              timestamp: '2026-11-03T19:00:01.000Z',
              message: {
                id: 'msg_answer',
                role: 'assistant',
                model: 'claude-opus-5-5',
                content: [{ type: 'text', text: 'Remembered' }],
                stop_reason: 'end_turn'
              }
            }
          ]
            .map((row) => JSON.stringify(row))
            .join('\n')}\n`
        )
        return {
          sessionId: COPY,
          filePath,
          coverage: {
            unit: agent === 'claude' ? 'claude-entry' : 'codex-turn',
            ids: agent === 'claude' ? ['prompt', 'answer'] : ['completed-turn']
          },
          ...(agent === 'claude' ? { resumeCursor: 'answer' } : {})
        }
      }
      await writeFile(
        filePath,
        `${[
          {
            type: 'session_meta',
            payload: { id: COPY, timestamp: '2026-11-03T19:00:00.000Z', cwd: rig.root }
          },
          {
            type: 'response_item',
            timestamp: '2026-11-03T19:00:01.000Z',
            payload: { type: 'message', role: 'user', content: 'Remember the nonce 57319' }
          }
        ]
          .map((row) => JSON.stringify(row))
          .join('\n')}\n`
      )
      return {
        sessionId: COPY,
        filePath,
        coverage: { unit: 'codex-turn' as const, ids: ['completed-turn'] }
      }
    }
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: preparation reads only these source/store/adapter facets; destination founding uses the real rig host below.
  const host = {
    deps: {
      store: {
        selectWritableRecord: () => ({ kind: 'writable' }),
        requireWritableRecord: () => record,
        listConversations: () => [],
        admittedSendCount: () => admissions
      },
      agents: { capabilities: () => ({ fork: capability }) },
      adapter: { copyConversation: copy },
      logger: { warn: vi.fn() },
      resolveWorkspacePath: async () => rig.root
    },
    journalSnapshot: async () => snapshot
  } as unknown as StructuredAgentSessionHost
  const intent = structuredAgentSessionCreateParams({
    sessionId: `${agent}_independent_child`,
    agent,
    worktree: 'id:workspace-1',
    forkFrom: {
      sessionId: record.sessionId,
      throughItemId: 'legacy:codex:source:selected-response'
    },
    now: rig.clock.now,
    randomUuid: () => '00000000-0000-0000-0000-000000000123'
  })
  const prepare = () =>
    prepareStructuredAgentSessionFork({
      host,
      sessionId: record.sessionId,
      throughItemId: 'legacy:codex:source:selected-response',
      agent,
      location: record.location,
      envelope: intent.envelope
    })
  return {
    record,
    snapshot,
    copy,
    host,
    intent,
    prepare,
    admit: () => {
      admissions++
    },
    tip: () => {
      capability = 'tip'
      snapshot.items = snapshot.items.filter(
        (item) => item.itemId !== 'legacy:codex:source:running-root'
      )
    }
  }
}
