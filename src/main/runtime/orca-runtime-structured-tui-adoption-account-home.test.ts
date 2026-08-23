/**
 * Adoption against the REAL account-home resolution.
 *
 * Why this rig exists: every other adoption test stubs the intent resolver with a hardcoded
 * `accountHome`, so none of them could see that adoption resolved the CURRENTLY SELECTED Codex
 * account's home instead of the one the pane's Codex is actually running under. Here the pane's
 * home comes from the real pane-account registry and the real settings, and the rollout fixture
 * exists ONLY under the pane's home — so probing the selected account's home fails the proof.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStructuredAgentSessionOperationId } from '../../shared/structured-agent-session-mutation'
import { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  _internals as codexPaneAccountRegistryInternals,
  type CodexPaneAccountRecord
} from '../codex/codex-pane-account-registry'
import { AgentSessionRecordStore } from './agent-session-record-store'
import { agentSessionPtyWriteGate } from './agent-session-pty-write-gate'
import { createStructuredAgentSessionOwnerProbe } from './structured-agent-session-runtime'
import { OrcaRuntimeService } from './orca-runtime'

const { readStructuredTuiProcessIdentity } = vi.hoisted(() => ({
  readStructuredTuiProcessIdentity: vi.fn()
}))
// The only OS-dependent step in the flow; the rollout proof and the account-home resolution stay real.
vi.mock('./structured-tui-process-identity', () => ({ readStructuredTuiProcessIdentity }))

const WORKTREE_ID = 'repo-1::/tmp/structured-adoption-home'
const PTY_ID = 'pty-adopt'
const PANE_KEY = 'tab-adopt:leaf-adopt'
const THREAD_ID = '019fd532-7c11-7a90-b6de-4e1a2c3d5f61'
const SESSION_ID = `codex_${THREAD_ID.replaceAll('-', '_')}`
const PANE_ACCOUNT_ID = 'codex-account-pane'
const SELECTED_ACCOUNT_ID = 'codex-account-selected'

type AdoptionRig = {
  runtime: OrcaRuntimeService
  store: AgentSessionRecordStore
  host: StructuredAgentSessionHost
  proofWrites: string[]
}

let root: string
let paneAccountHome: string
let selectedAccountHome: string
let sharedRuntimeHome: string
let rig: AdoptionRig

async function writeRolloutFixture(codexHome: string, threadId: string): Promise<void> {
  const dir = join(codexHome, 'sessions', '2026', '08', '19')
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, `rollout-2026-08-19T10-00-00-${threadId}.jsonl`),
    `${JSON.stringify({ type: 'session_meta', payload: { id: threadId } })}\n`,
    'utf8'
  )
}

/** Writes the registry file the real `getCodexPaneAccount` reads at adoption time. */
async function recordPaneAccount(record: CodexPaneAccountRecord | null): Promise<void> {
  await writeFile(
    join(root, 'codex-pane-accounts.json'),
    `${JSON.stringify({ version: 2, panes: record ? { [PTY_ID]: record } : {} })}\n`,
    'utf8'
  )
  codexPaneAccountRegistryInternals.resetCache()
}

function buildSettings() {
  const account = (id: string, managedHomePath: string) => ({
    id,
    email: `${id}@example.com`,
    managedHomePath,
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1
  })
  return {
    // Why a configured CODEX_HOME: it is what the create intent resolves to in this rig, so an
    // adoption that follows the selection probes THIS home instead of the pane's.
    agentDefaultEnv: { codex: { CODEX_HOME: selectedAccountHome } },
    activeCodexManagedAccountId: SELECTED_ACCOUNT_ID,
    codexManagedAccounts: [
      account(PANE_ACCOUNT_ID, paneAccountHome),
      account(SELECTED_ACCOUNT_ID, selectedAccountHome)
    ]
  }
}

function installProofPty(rigState: AdoptionRig, ptyRecord: { lastOutputAt: number }) {
  return (ptyId: string, data: string, authority: { sessionId: string; spawnToken: string }) => {
    if (!agentSessionPtyWriteGate.admitProof(ptyId, authority)) {
      return false
    }
    rigState.proofWrites.push(data)
    if (data === '\r') {
      const internal = rigState.runtime as unknown as {
        ptysById: Map<string, { tailBuffer: string[]; lastOutputAt: number }>
      }
      const pty = internal.ptysById.get(PTY_ID)!
      pty.tailBuffer = [`Session ID: ${THREAD_ID}`]
      pty.lastOutputAt = ptyRecord.lastOutputAt + 1_000
    }
    return true
  }
}

async function buildRig(): Promise<AdoptionRig> {
  const store = await AgentSessionRecordStore.open({
    directory: join(root, 'agent-sessions'),
    hostId: 'local'
  })
  agentSessionPtyWriteGate.attachRecordLookup((sessionId) => store.getRecord(sessionId))
  const host = new StructuredAgentSessionHost({
    store,
    adapter: {
      supportsCreate: () => true,
      acquire: vi.fn(),
      dispatch: vi.fn(),
      cancelTurn: vi.fn(),
      answerPrompt: vi.fn(),
      setOption: vi.fn()
    },
    journalRoot: join(root, 'journals'),
    claimKeyId: 'key-1',
    probeOwner: createStructuredAgentSessionOwnerProbe(
      'local',
      async () => ({ outcome: 'identity-matched', matchedOn: ['process-start-time'] }),
      async () => []
    )
  })
  setStructuredAgentSessionHost(host)

  const runtime = new OrcaRuntimeService({ getSettings: () => buildSettings() } as never)
  const state: AdoptionRig = { runtime, store, host, proofWrites: [] }
  const ptyRecord = {
    ptyId: PTY_ID,
    connected: true,
    connectionId: null,
    wslDistro: null,
    tabId: 'tab-adopt',
    paneKey: PANE_KEY,
    worktreeId: WORKTREE_ID,
    incarnationId: 'inc-adopt',
    tailBuffer: [] as string[],
    tailPartialLine: '',
    preview: '',
    lastOutputAt: 1_000
  }
  const internal = runtime as unknown as {
    ptysById: Map<string, unknown>
    resolveRuntimeFileTarget(): Promise<unknown>
    resolveStructuredAgentSessionLocation(): Promise<unknown>
    ensureStructuredAgentSessionHost(): Promise<void>
    issueStructuredTuiPtyHandle(): string
  }
  internal.ptysById.set(PTY_ID, ptyRecord)
  internal.resolveRuntimeFileTarget = vi.fn(async () => ({
    connectionId: null,
    worktree: { id: WORKTREE_ID, path: join(root, 'workspace') }
  }))
  internal.resolveStructuredAgentSessionLocation = vi.fn(async () => ({
    executionHostId: 'local',
    wslDistro: null,
    workspaceId: WORKTREE_ID,
    workspaceKind: 'git-worktree'
  }))
  // The rig owns the host; installing the real one would replace it with an on-disk singleton.
  internal.ensureStructuredAgentSessionHost = vi.fn(async () => {})
  internal.issueStructuredTuiPtyHandle = vi.fn(() => 'term-adopt')
  runtime.setPtyController({
    listProcesses: async () => [{ id: PTY_ID, incarnationId: 'inc-adopt', rootProcessId: 31337 }],
    writeAgentSessionProof: installProofPty(state, ptyRecord)
  } as never)
  return state
}

function adoptInput() {
  return {
    envelope: {
      sessionId: SESSION_ID,
      clientOperationId: createStructuredAgentSessionOperationId(() => randomUUID()),
      expectedRuntimeFence: null as null,
      payloadFingerprint: 'a'.repeat(64)
    },
    worktree: `id:${WORKTREE_ID}`,
    tabId: 'tab-adopt',
    paneKey: PANE_KEY,
    ptyId: PTY_ID,
    threadId: THREAD_ID
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-adopt-home-'))
  vi.stubEnv('ORCA_USER_DATA_PATH', root)
  paneAccountHome = join(root, 'codex-accounts', PANE_ACCOUNT_ID, 'home')
  selectedAccountHome = join(root, 'codex-accounts', SELECTED_ACCOUNT_ID, 'home')
  sharedRuntimeHome = join(root, 'codex-runtime-home', 'home')
  await recordPaneAccount({
    selectionKey: 'host',
    accountId: PANE_ACCOUNT_ID,
    homeRoute: 'account-home'
  })
  readStructuredTuiProcessIdentity.mockImplementation(
    async (input: { hostId: string; spawnToken: string }) => ({
      hostId: input.hostId,
      pid: 4242,
      processStartTimeMs: 1_700_000_000_000,
      spawnToken: input.spawnToken
    })
  )
  rig = await buildRig()
})

afterEach(async () => {
  agentSessionPtyWriteGate.unbindPty(PTY_ID)
  agentSessionPtyWriteGate.detachRecordLookup()
  setStructuredAgentSessionHost(null)
  codexPaneAccountRegistryInternals.resetCache()
  vi.unstubAllEnvs()
  await rig.host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

describe('structured Codex adoption resolves the account home from the pane', () => {
  it('adopts a local-fallback pane from its shared-home launch provenance', async () => {
    await recordPaneAccount({
      selectionKey: 'host',
      accountId: null,
      homeRoute: 'shared-home'
    })
    await writeRolloutFixture(sharedRuntimeHome, THREAD_ID)

    const result = await rig.runtime.adoptStructuredAgentSessionTerminal(adoptInput(), {
      callerKey: 'renderer-1'
    })

    expect(result).toMatchObject({ ok: true })
    expect(rig.store.getRecord(SESSION_ID)).toMatchObject({
      accountHome: { variable: 'CODEX_HOME', path: sharedRuntimeHome },
      lease: { runtimeKind: 'tui', claimStatus: 'live' }
    })
  }, 20_000)

  it('adopts a pane whose Codex runs under a non-selected account home', async () => {
    // Only the pane's account owns the rollout; the selected account's home has none.
    await writeRolloutFixture(paneAccountHome, THREAD_ID)

    const result = await rig.runtime.adoptStructuredAgentSessionTerminal(adoptInput(), {
      callerKey: 'renderer-1'
    })

    expect(result).toMatchObject({ ok: true })
    expect(rig.store.getRecord(SESSION_ID)).toMatchObject({
      accountHome: { variable: 'CODEX_HOME', path: paneAccountHome },
      lease: { runtimeKind: 'tui', claimStatus: 'live' }
    })
  }, 20_000)

  it('still adopts a pane whose account is the selected one', async () => {
    await recordPaneAccount({
      selectionKey: 'host',
      accountId: SELECTED_ACCOUNT_ID,
      homeRoute: 'account-home'
    })
    await writeRolloutFixture(selectedAccountHome, THREAD_ID)

    const result = await rig.runtime.adoptStructuredAgentSessionTerminal(adoptInput(), {
      callerKey: 'renderer-1'
    })

    expect(result).toMatchObject({ ok: true })
    expect(rig.store.getRecord(SESSION_ID)).toMatchObject({
      accountHome: { path: selectedAccountHome }
    })
  }, 20_000)

  it('refuses a pane whose Codex home cannot be attributed instead of probing another account', async () => {
    await recordPaneAccount(null)
    await writeRolloutFixture(selectedAccountHome, THREAD_ID)

    await expect(
      rig.runtime.adoptStructuredAgentSessionTerminal(adoptInput(), { callerKey: 'renderer-1' })
    ).rejects.toThrow('no record of which Codex account this terminal launched under')
    // Nothing was probed and nothing was reserved, so the wrong home was never consulted.
    expect(rig.proofWrites).toEqual([])
    expect(agentSessionPtyWriteGate.boundSessionId(PTY_ID)).toBeNull()
    expect(rig.store.getRecord(SESSION_ID)).toBeNull()
  })

  it('names the account when the pane launched under one that is gone', async () => {
    await recordPaneAccount({
      selectionKey: 'host',
      accountId: 'codex-account-removed',
      homeRoute: 'account-home'
    })

    await expect(
      rig.runtime.adoptStructuredAgentSessionTerminal(adoptInput(), { callerKey: 'renderer-1' })
    ).rejects.toThrow('managed account codex-account-removed, which is no longer configured')
  })

  it('leaves create following the selected account, not the adopted pane', async () => {
    const created = await rig.runtime.resolveStructuredAgentSessionCreateIntent({
      envelope: { sessionId: SESSION_ID, clientOperationId: 'op-create' },
      worktree: `id:${WORKTREE_ID}`,
      agent: 'codex'
    })

    // The registry still names the pane's account; a create must ignore it.
    expect(created.accountHome).toEqual({ variable: 'CODEX_HOME', path: selectedAccountHome })
  })
})
