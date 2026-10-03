import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { mapRuntimeError } from '../../runtime/rpc/errors'
import {
  AgentSessionPreSpawnError,
  type AgentSessionPreSpawnReason,
  type StructuredAgentSessionAdapter
} from './structured-agent-session-adapter'
import {
  attachFingerprintFields,
  type AgentSessionAttachParams
} from './structured-agent-session-attach'
import { openTestAttachConversation } from './structured-agent-session-attach-test-conversation'
import { performAttach } from './structured-agent-session-attach-flow'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'

const NOW = 1_800_000_000_000
const SESSION = 'session-alpha'
const OPERATION = `${NOW}-${'1'.padStart(32, '0')}`
let root: string | null = null

afterEach(async () => {
  vi.restoreAllMocks()
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
  root = null
})

function createParams(): AgentSessionAttachParams {
  const params: AgentSessionAttachParams = {
    envelope: {
      sessionId: SESSION,
      clientOperationId: OPERATION,
      expectedRuntimeFence: null,
      payloadFingerprint: ''
    },
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'folder'
    },
    provider: 'claude',
    agent: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/dev/.claude' },
    runtimeKind: 'native'
  }
  return {
    ...params,
    envelope: {
      ...params.envelope,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.attach',
        sessionId: SESSION,
        fields: attachFingerprintFields(params)
      })
    }
  }
}

/** The thrown first answer as the wire sends it, and the ledger's replay of the same operation. */
async function firstAnswerAndReplay(thrown: AgentSessionPreSpawnError) {
  root = await mkdtemp(join(tmpdir(), 'orca-pre-spawn-first-answer-'))
  const store = await openTestAgentSessionRecordStore(root)
  const unused = async (): Promise<never> => {
    throw new Error('not reached before a spawn')
  }
  const adapter: StructuredAgentSessionAdapter = {
    acquire: async () => {
      throw thrown
    },
    dispatch: unused,
    cancelTurn: unused,
    answerPrompt: unused,
    setOption: unused
  }
  const input = {
    store,
    adapter,
    logger: createStructuredAgentSessionLogger(),
    journalDatabase: openTestJournalHostDatabase(root),
    openConversation: openTestAttachConversation(openTestJournalHostDatabase(root)),
    authority: {
      spawnToken: 'spawn-a',
      claimKeyId: 'key-1',
      handoffOperationId: OPERATION,
      probe: { outcome: 'reservation-unused' as const }
    },
    callerKey: 'client-1',
    params: createParams(),
    now: () => NOW,
    onAttached: () => {}
  }
  const first = await performAttach(input).then(
    () => null,
    (error: unknown) => error
  )
  expect(first).toBeInstanceOf(AgentSessionPreSpawnError)
  return {
    first: mapRuntimeError('req-1', { runtimeId: 'runtime-1' }, first),
    replay: await performAttach(input)
  }
}

describe('a create that fails before any process spawns', () => {
  it.each<[string, string, AgentSessionPreSpawnReason | undefined, string]>([
    [
      'the managed account env override',
      'This Claude launch defines explicit Anthropic auth environment variables.',
      'managedAccountEnvOverride',
      'This Claude launch sets its own Anthropic sign-in variables. Remove them to use a managed Claude account.'
    ],
    [
      'an account switch in progress',
      'A Claude account switch is in progress. Try again after it finishes.',
      'accountSwitchInProgress',
      'A Claude account switch is in progress. Try again after it finishes.'
    ],
    [
      'a Claude account added in WSL',
      'structured Claude is not offered under the active managed Claude account',
      'managedAccountUnsupported',
      'While a Claude account is added in WSL, Claude chats need a Windows Claude account. Choose or add one in Claude Accounts settings, then send your message again.'
    ],
    [
      "Orca's own reason",
      'claude sessions pin CLAUDE_CONFIG_DIR, not CODEX_HOME',
      undefined,
      "Claude couldn't start. Send your message to try again."
    ]
  ])('answers %s first in the words its replay reads', async (_, raw, reason, sentence) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const { first, replay } = await firstAnswerAndReplay(
      new AgentSessionPreSpawnError(new Error(raw), reason ? { reason } : {})
    )

    // Thrown as before: the wire code is unchanged, only the words are the replay's.
    expect(first).toMatchObject({ ok: false, error: { code: 'runtime_error', message: sentence } })
    expect(replay).toMatchObject({
      ok: false,
      refusal: {
        code: 'agent_session_operation_invalid',
        message: sentence,
        ...(reason ? { details: { reason } } : {})
      }
    })
    if (!reason) {
      expect(replay).not.toHaveProperty('refusal.details')
    }
    if (raw !== sentence) {
      expect(JSON.stringify([first, replay])).not.toContain(raw)
    }
    // What failed is kept for the log.
    expect(warn).toHaveBeenCalledWith(
      '[agent-session] provider-start: starting the provider failed',
      expect.objectContaining({
        scope: 'provider-start',
        error: expect.objectContaining({ message: raw })
      })
    )
  })

  it('keeps a message that is itself a code, and the wire code it maps to', async () => {
    const { first } = await firstAnswerAndReplay(
      new AgentSessionPreSpawnError(new Error('runtime_unavailable'))
    )

    expect(first).toMatchObject({
      ok: false,
      error: { code: 'runtime_unavailable', message: 'runtime_unavailable' }
    })
  })

  it('keeps the situation of a pre-spawn error it wraps', () => {
    const typed = new AgentSessionPreSpawnError(new Error('switching'), {
      reason: 'accountSwitchInProgress'
    })

    expect(new AgentSessionPreSpawnError(typed).reason).toBe('accountSwitchInProgress')
  })
})
