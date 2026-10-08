// Forking a turn against the real CLI and SDK: the fork point Orca records when a real turn ends is
// one the SDK cuts at, and a forked chat's first start, through Orca's own launch, copies that turn
// and nothing after it and carries on from the copy. Runs only where a signed-in Claude CLI exists.

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalTurnLifecycle,
  AgentSessionJournalIdentity
} from '../../shared/agent-session-journal-types'
import { claudeProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import {
  agentJournalTurnForkPoint,
  readAgentJournalTurn
} from '../../shared/agent-session-turn-record'
import { prepareLegacyTranscriptImport } from '../native-chat/agent-session-journal/journal-legacy-import'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import {
  realClaudeAuthenticated,
  realClaudeAvailable,
  realClaudeCommand,
  realClaudeLaunchHome
} from './claude-real-cli-availability-test-support'
import { forkClaudeSession } from './claude-session-fork'
import { claudeTranscriptPath } from './claude-structured-launch-home'
import { buildClaudeSessionForkWorkerEntry } from './claude-session-fork-worker-test-support'
import {
  CLAUDE_STRUCTURED_BASE_OPTIONS,
  createClaudeStructuredLaunchResolver
} from './claude-structured-launch-resolution'
import {
  ClaudeStructuredSessionAdapter,
  type ClaudeStructuredSessionEvent
} from './claude-structured-session-adapter'
import { claudeStartupSettled } from './claude-structured-session-test-support'

async function until(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) {
      return true
    }
    await new Promise((settle) => setTimeout(settle, 200))
  }
  return check()
}

type ResolveLaunch = ConstructorParameters<
  typeof ClaudeStructuredSessionAdapter
>[0]['resolveLaunch']

/** One Orca session on the real CLI: sends a prompt and waits for the turn's result. */
async function openSession(input: {
  sessionId: string
  /** The provider conversation a fresh chat starts; absent for one `resolveLaunch` decides. */
  providerSessionId?: string
  resolveLaunch?: ResolveLaunch
  cwd: string
}) {
  const { claudeConfigDir, env } = realClaudeLaunchHome()
  const providerSessionId = input.providerSessionId ?? ''
  const events: ClaudeStructuredSessionEvent[] = []
  const turns = new Map<string, AgentJournalTurnLifecycle>()
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (_identity, body: AgentJournalItemBody) => {
      const turn = readAgentJournalTurn(body)
      if (turn) {
        turns.set(turn.turnId, turn)
      }
    },
    appendTombstone: () => {},
    publish: () => {}
  }
  const adapter = new ClaudeStructuredSessionAdapter({
    resolveLaunch:
      input.resolveLaunch ??
      (async () => ({
        pathToClaudeCodeExecutable: realClaudeCommand,
        options: { ...CLAUDE_STRUCTURED_BASE_OPTIONS, sessionId: providerSessionId },
        cwd: input.cwd,
        env,
        claudeConfigDir,
        providerSessionId,
        resumeLeafUuid: null,
        resumesTranscript: false,
        continuesChain: false
      })),
    onEvent: (event) => events.push(event),
    readProcessStartTime: async () => 1
  })
  const identity: AgentSessionJournalIdentity = {
    sessionId: input.sessionId,
    workspaceId: 'real-cli-fork-workspace',
    hostId: 'local',
    agent: 'claude',
    providerHandle: input.providerSessionId
      ? claudeProviderHandle(input.providerSessionId, null)
      : null
  }
  const acquisition = await adapter.acquire({
    identity,
    fence: 1,
    spawnToken: input.sessionId,
    events: sink
  })
  await claudeStartupSettled(adapter, input.sessionId)
  const results = () =>
    events.filter((event) => event.type === 'message' && event.message.type === 'result').length
  let sent = 0
  return {
    adapter,
    acquisition,
    turns: () => [...turns.values()],
    ask: async (text: string) => {
      const before = results()
      sent += 1
      await adapter.dispatch({
        sessionId: input.sessionId,
        clientMessageId: `${input.sessionId}-${sent}`,
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] },
        requestedAt: Date.now(),
        fence: 1
      })
      expect(await until(() => results() > before, 90_000)).toBe(true)
    }
  }
}

describe.skipIf(!realClaudeAvailable)('Claude structured real CLI fork', () => {
  it.skipIf(!realClaudeAuthenticated)(
    'copies a real chat through its first turn, and the copy carries on',
    async () => {
      const { claudeConfigDir } = realClaudeLaunchHome()
      const cwd = await mkdtemp(join(tmpdir(), 'orca-real-fork-'))
      const parentId = randomUUID()
      const worker = await buildClaudeSessionForkWorkerEntry()
      const transcriptOf = async (providerSessionId: string): Promise<string> => {
        const path = await claudeTranscriptPath({ providerSessionId, claudeConfigDir })
        expect(path).not.toBeNull()
        return path ?? ''
      }
      const parent = await openSession({
        sessionId: 'real-cli-fork-parent',
        providerSessionId: parentId,
        cwd
      })
      let copy: Awaited<ReturnType<typeof openSession>> | null = null
      try {
        await parent.ask('Reply with exactly the word PINEAPPLE and nothing else.')
        await parent.ask('Reply with exactly the word WALRUS and nothing else.')
        const [first, second] = parent.turns()
        const forkPoint = agentJournalTurnForkPoint('claude', first ?? null)
        // Both turns ended as the provider's successes, so both recorded where they end.
        expect(forkPoint).not.toBeNull()
        expect(agentJournalTurnForkPoint('claude', second ?? null)).not.toBe(forkPoint)
        const parentPath = await transcriptOf(parentId)
        const parentBefore = readFileSync(parentPath, 'utf8')

        // The forked chat as its create reserves it: no conversation yet, only where to cut one.
        const copyRecord: AgentSessionRecord = {
          ...agentSessionRecordFixture(),
          sessionId: 'real-cli-fork-copy',
          accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: claudeConfigDir },
          launchDirectory: cwd,
          providerHandleChain: [],
          forkedFrom: {
            sessionId: 'real-cli-fork-parent',
            itemId: 'unused',
            providerSessionId: parentId,
            forkPoint: forkPoint ?? ''
          }
        }
        copy = await openSession({
          sessionId: copyRecord.sessionId,
          cwd,
          resolveLaunch: createClaudeStructuredLaunchResolver({
            store: { getRecord: () => copyRecord, pinLaunchDirectory: async () => copyRecord },
            resolveWorkspacePath: async () => cwd,
            resolveCommand: () => realClaudeCommand,
            resolveLaunchArgs: () => [],
            resolveEnv: () => realClaudeLaunchHome().env,
            resolveAuthPolicy: () => ({ stripAuthEnv: false }),
            forkSession: (job) => forkClaudeSession(job, worker.entry)
          })
        })
        const { link } = copy.acquisition
        const history = await copy.adapter.forkedHistory(copyRecord.sessionId)
        expect(history?.providerSessionId).toBe(link.handle.nativeId)
        expect(link.origin).toBe('adopted')
        expect(link.handle.nativeId).not.toBe(parentId)

        // What Orca's own importer shows for the copy: the first turn whole, none of the second.
        const imported = await prepareLegacyTranscriptImport({
          agent: 'claude',
          sessionId: link.handle.nativeId,
          options: { filePath: history?.transcriptPath ?? '' }
        })
        expect(imported.ok).toBe(true)
        // The prompts spell the answers too, so only what the assistant said is evidence.
        const answers = JSON.stringify(
          (imported.ok ? imported.items : []).filter(
            (item) => item.body.kind === 'message' && item.body.role === 'assistant'
          )
        )
        expect(answers).toContain('PINEAPPLE')
        expect(answers).not.toContain('WALRUS')
        expect(readFileSync(parentPath, 'utf8')).toBe(parentBefore)

        // The copy is a chat of its own: it takes a turn.
        await copy.ask('Reply with exactly the word OTTER and nothing else.')
        expect(copy.turns().at(-1)).toMatchObject({ state: 'completed', outcome: 'success' })
        expect(readFileSync(parentPath, 'utf8')).toBe(parentBefore)
      } finally {
        await parent.adapter.closeAll()
        await copy?.adapter.closeAll()
        worker.dispose()
      }
    },
    240_000
  )
})
