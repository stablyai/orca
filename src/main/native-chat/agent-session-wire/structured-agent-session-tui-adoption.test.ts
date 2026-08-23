import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'
import type { StructuredTuiOwner } from './structured-agent-session-handoff-types'

const CALLER = { callerKey: 'client-1' }

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let acquire: ReturnType<typeof vi.fn<StructuredAgentSessionAdapter['acquire']>>

function params(): AgentSessionAttachParams {
  return hostTestAttachParams(null, { runtimeKind: 'tui' })
}

function owner(): StructuredTuiOwner {
  return {
    terminal: {
      handle: 'term-adopted',
      tabId: 'tab-adopted',
      paneKey: 'tab-adopted:leaf-adopted',
      ptyId: 'pty-adopted'
    },
    process: {
      hostId: 'local',
      pid: 5252,
      processStartTimeMs: NOW - 100,
      spawnToken: 'adopted-spawn'
    },
    link: {
      linkId: 'adopted-link',
      handle: { provider: 'codex', threadId: THREAD },
      origin: 'adopted',
      mintedAtFence: 1,
      observedAt: NOW
    },
    transcriptPath: '/home/dev/.codex/sessions/rollout.jsonl',
    historySource: 'provider-resume',
    adoptedTerminal: true
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-tui-adoption-'))
  resetHostTestOperationIds()
  acquire = vi.fn()
  store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
  host = new StructuredAgentSessionHost({
    store,
    adapter: {
      acquire,
      dispatch: vi.fn(),
      cancelTurn: vi.fn(),
      answerPrompt: vi.fn(),
      setOption: vi.fn()
    },
    journalRoot: root,
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-a',
    now: () => NOW
  })
})

afterEach(async () => {
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

/** What the runtime does before it may type `/status` into the pane it is adopting. */
async function reserveAdoption(attach: AgentSessionAttachParams, spawnToken: string) {
  return host.reserveAdoptedTuiOwner({
    caller: CALLER,
    sessionId: attach.envelope.sessionId,
    clientOperationId: attach.envelope.clientOperationId,
    fingerprint: attach.envelope.payloadFingerprint,
    location: attach.location,
    provider: 'codex',
    accountHome: attach.accountHome,
    spawnToken,
    claimKeyId: 'key-1'
  })
}

describe('structured TUI adoption', () => {
  it('mints a durable TUI owner without starting a native provider', async () => {
    const adoptedOwner = owner()
    const attach = params()
    await expect(reserveAdoption(attach, adoptedOwner.process.spawnToken)).resolves.toMatchObject({
      ok: true,
      fence: 1
    })

    const result = await host.adoptTuiOwner({
      caller: CALLER,
      params: attach,
      owner: adoptedOwner
    })

    expect(result).toMatchObject({ ok: true, replayed: false, fence: 1 })
    expect(acquire).not.toHaveBeenCalled()
    expect(store.getRecord(SESSION)).toMatchObject({
      providerHandleChain: [{ origin: 'adopted', handle: { threadId: THREAD } }],
      lease: { runtimeKind: 'tui', claimStatus: 'live', ownerProcess: adoptedOwner.process }
    })
    await expect(host.handoffStatus(SESSION)).resolves.toMatchObject({
      owner: 'tui',
      phase: 'idle',
      terminal: adoptedOwner.terminal
    })
  })

  it('refuses input whose durable identity fingerprint changed', async () => {
    const invalid = params()
    invalid.envelope.payloadFingerprint = '0'.repeat(64)

    const result = await host.adoptTuiOwner({ caller: CALLER, params: invalid, owner: owner() })

    expect(result).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_conflict' }
    })
    expect(store.getRecord(SESSION)).toBeNull()
    expect(acquire).not.toHaveBeenCalled()
  })

  // The reservation is the only way in: adoption has no second mode that acquires the lease
  // itself, so nothing here may invent an owner for a session the store has never heard of.
  it('refuses to adopt a session that holds no reservation', async () => {
    await expect(
      host.adoptTuiOwner({ caller: CALLER, params: params(), owner: owner() })
    ).rejects.toThrow('agent_session_ownership_unknown')
    expect(store.getRecord(SESSION)).toBeNull()
    expect(acquire).not.toHaveBeenCalled()
  })
})
