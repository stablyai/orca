import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type {
  AgentSessionHandoffDirection,
  AgentSessionHandoffRequest,
  AgentSessionMutationEnvelope
} from '../../../shared/agent-session-wire'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'
import type {
  StructuredAgentSessionHandoffTransport,
  StructuredTuiOwner
} from './structured-agent-session-handoff-types'

const CALLER = { callerKey: 'client-claude' }
const CLAUDE_SESSION = '019fd532-7c11-7a90-b6de-4e1a2c3d5f61'
const DEFAULT_MODEL = 'sonnet'
const PICKED_MODEL = 'opus'

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let acquire: Mock<StructuredAgentSessionAdapter['acquire']>
let activeModel: string
let transcriptPath: string

function envelope(method: string, fields: Record<string, unknown>): AgentSessionMutationEnvelope {
  return {
    sessionId: SESSION,
    clientOperationId: hostTestOperationId(),
    expectedRuntimeFence: store.getRecord(SESSION)?.lease.runtimeFence ?? null,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method,
      sessionId: SESSION,
      fields
    })
  }
}

function handoff(direction: AgentSessionHandoffDirection): AgentSessionHandoffRequest {
  const fields = { direction, mode: 'now' as const, action: 'start' as const }
  return { envelope: envelope('agentSession.requestHandoff', fields), ...fields }
}

function owner(fence: number, spawnToken: string): StructuredTuiOwner {
  return {
    terminal: {
      handle: 'term-claude',
      tabId: 'tab-claude',
      paneKey: 'pane-claude',
      ptyId: 'pty-claude'
    },
    process: { hostId: 'local', pid: 5200, processStartTimeMs: NOW, spawnToken },
    link: {
      linkId: `claude-tui-${fence}`,
      handle: { provider: 'claude', sessionId: CLAUDE_SESSION, leafUuid: 'tui-leaf' },
      origin: 'resumed',
      mintedAtFence: fence,
      observedAt: NOW
    },
    transcriptPath
  }
}

function transport(): StructuredAgentSessionHandoffTransport {
  return {
    hostLabel: 'Test host',
    launchTui: async ({ fence, spawnToken }) => owner(fence, spawnToken),
    reproveTuiOwner: async ({ owner: current }) => current,
    recoverTuiOwner: async (record) =>
      owner(
        record.lease.runtimeFence,
        record.lease.ownerProcess?.spawnToken ?? record.lease.reservedSpawnToken ?? 'recovered'
      ),
    stopRecoveredOwner: async () => undefined,
    waitForTuiExit: async (current) => ({ transcriptPath: current.transcriptPath }),
    waitForTuiIdleOrExit: async () => 'idle',
    tuiStatus: () => 'idle'
  }
}

function adapter(): StructuredAgentSessionAdapter {
  acquire = vi.fn(async ({ fence, spawnToken, options }) => {
    activeModel = options?.model ?? DEFAULT_MODEL
    return {
      process: { hostId: 'local', pid: 4200, processStartTimeMs: NOW, spawnToken },
      link: {
        linkId: `claude-native-${fence}`,
        handle: { provider: 'claude', sessionId: CLAUDE_SESSION, leafUuid: 'native-leaf' },
        origin: acquire.mock.calls.length === 1 ? 'created' : 'resumed',
        mintedAtFence: fence,
        observedAt: NOW
      }
    }
  })
  return {
    acquire,
    dispatch: vi.fn(),
    cancelTurn: vi.fn(async () => ({ cancelled: true })),
    answerPrompt: vi.fn(async () => undefined),
    setOption: vi.fn(async ({ value }) => {
      activeModel = value
      return { model: value }
    }),
    readOptions: vi.fn(async () => ({ current: { model: activeModel }, models: [] })),
    closeSession: vi.fn(async () => {
      activeModel = DEFAULT_MODEL
      return true
    })
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-handoff-options-'))
  resetHostTestOperationIds()
  activeModel = DEFAULT_MODEL
  transcriptPath = join(root, 'claude.jsonl')
  await writeFile(transcriptPath, '', 'utf8')
  store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
  host = new StructuredAgentSessionHost({
    store,
    adapter: adapter(),
    journalRoot: root,
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-claude',
    handoffTransport: transport(),
    now: () => NOW
  })
  expect(
    await host.attach(
      CALLER,
      hostTestAttachParams(null, {
        provider: 'claude',
        agent: 'claude',
        accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: join(root, 'claude-home') },
        providerHandle: { kind: 'claude', sessionId: CLAUDE_SESSION, leafUuid: 'native-leaf' }
      })
    )
  ).toMatchObject({ ok: true })
})

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 100))
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
})

describe('Claude structured session handoff options', () => {
  it('keeps a directly selected model through chat to TUI to chat', async () => {
    const fields = { key: 'model', value: PICKED_MODEL }
    expect(
      await host.setOption(CALLER, {
        envelope: envelope('agentSession.setOption', fields),
        ...fields
      })
    ).toMatchObject({ ok: true, value: { options: { model: PICKED_MODEL } } })

    expect(await host.requestHandoff(CALLER, handoff('to-tui'))).toMatchObject({ ok: true })
    await vi.waitFor(async () =>
      expect(await host.handoffStatus(SESSION)).toMatchObject({ owner: 'tui' })
    )
    expect(await host.requestHandoff(CALLER, handoff('to-native'))).toMatchObject({ ok: true })
    await vi.waitFor(async () =>
      expect(await host.handoffStatus(SESSION)).toMatchObject({ owner: 'native' })
    )

    expect(acquire.mock.calls[1]?.[0].options).toEqual({ model: PICKED_MODEL })
    expect(store.getRecord(SESSION)?.options).toEqual({ model: PICKED_MODEL })
    expect(activeModel).toBe(PICKED_MODEL)
  })
})
