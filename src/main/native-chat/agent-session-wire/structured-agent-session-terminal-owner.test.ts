import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { RuntimeEnsureAgentSessionRequest } from '../../../shared/agent-session-host-authority'
import { ClaimedAgentPtyOwnerRegistry } from '../../../shared/claimed-agent-pty-owner'
import {
  AgentSessionClaimSigner,
  canonicalizeAgentSessionIdentity
} from '../../runtime/agent-session-claim-identity'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { AGENT_SESSION_METHODS } from '../../runtime/rpc/methods/agent-session'
import { RpcDispatcher } from '../../runtime/rpc/dispatcher'
import { openTestAttachConversation } from './structured-agent-session-attach-test-conversation'
import { performAttach } from './structured-agent-session-attach-flow'
import {
  attachFingerprintFields,
  type AgentSessionAttachParams
} from './structured-agent-session-attach'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import { setStructuredAgentSessionHost } from './structured-agent-session-registry'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import {
  openTestJournalHostDatabase,
  closeTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'

const NOW = 1_800_000_000_000
const THREAD = 'terminal-owned-thread'
let root: string | null = null

afterEach(async () => {
  setStructuredAgentSessionHost(null)
  if (root) {
    closeTestJournalHostDatabase(root)
    await rm(root, { recursive: true, force: true })
  }
  root = null
})

function signal() {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

async function rig() {
  root = await mkdtemp(join(tmpdir(), 'orca-terminal-owner-'))
  const stateDirectory = root
  await Promise.all(
    [THREAD, 'independent-thread'].map(async (thread) => {
      const lines = [
        JSON.stringify({
          type: 'session_meta',
          payload: { id: thread, timestamp: '2026-09-06T18:00:00Z', cwd: '/workspace' }
        }),
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'message', role: 'user', content: 'previous turn' }
        })
      ]
      await writeFile(join(stateDirectory, `${thread}.jsonl`), `${lines.join('\n')}\n`)
    })
  )
  let store = await openTestAgentSessionRecordStore(stateDirectory)
  const registry = new ClaimedAgentPtyOwnerRegistry()
  const signer = new AgentSessionClaimSigner('test-host', Buffer.alloc(32, 1))
  const namespace = {
    machine: 'test',
    principal: 'test',
    container: 'native',
    providerRoot: 'profile-default:codex'
  }
  const claimFor = (thread: string) =>
    signer.createClaim({
      namespace,
      identity: canonicalizeAgentSessionIdentity('codex', { key: 'session_id', id: thread }),
      canonicalWorktreeId: 'workspace-1'
    })
  const surface = {
    worktreeId: 'workspace-1',
    tabId: 'tab',
    leafId: 'leaf',
    terminalHandle: 'term'
  }
  const install = () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the RPC guard only reads this real store through deps.store.listRecords.
    setStructuredAgentSessionHost({ deps: { store } } as unknown as StructuredAgentSessionHost)
  }
  install()
  const spawnEntered = signal()
  const releaseSpawn = signal()
  let failSpawn = false
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    ensureStructuredAgentSessionHost: vi.fn(async () => {
      store = await openTestAgentSessionRecordStore(stateDirectory)
      install()
    }),
    ensureAgentSession: vi.fn(async (request: RuntimeEnsureAgentSessionRequest) => {
      if (request.kind !== 'explicit') {
        throw new Error('explicit request expected')
      }
      const owner = await registry.ensure({
        claim: claimFor(request.providerSession.id),
        surface,
        spawn: async () => {
          spawnEntered.resolve()
          await releaseSpawn.promise
          if (failSpawn) {
            throw new Error('spawn failed')
          }
          return { ptyId: `pty:${request.providerSession.id}` }
        }
      })
      return {
        terminal: { handle: 'term', worktreeId: 'workspace-1', title: null },
        disposition: owner.disposition
      }
    })
  }
  const dispatcher = new RpcDispatcher({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these registered RPCs only use the explicitly supplied install/ensure/runtime-id methods.
    runtime: runtime as unknown as OrcaRuntimeService,
    methods: AGENT_SESSION_METHODS
  })
  const terminal = (thread = THREAD) =>
    dispatcher.dispatch({
      id: 'resume',
      authToken: 'test',
      method: 'terminal.ensureAgentSession',
      params: {
        kind: 'explicit',
        worktree: 'id:workspace-1',
        agent: 'codex',
        providerSession: { key: 'session_id', id: thread }
      }
    })
  const acquireEntered = signal()
  let acquireBarrier = Promise.resolve()
  const adapter: StructuredAgentSessionAdapter = {
    acquire: vi.fn<StructuredAgentSessionAdapter['acquire']>(
      async ({ fence, spawnToken, identity }) => {
        acquireEntered.resolve()
        await acquireBarrier
        const providerHandle = identity.providerHandle
        const thread = providerHandle.kind === 'codex' ? providerHandle.threadId : THREAD
        return {
          process: { hostId: 'local', pid: 4242, processStartTimeMs: NOW, spawnToken },
          link: {
            linkId: 'link',
            handle: { provider: 'codex', threadId: thread },
            origin: 'resumed',
            mintedAtFence: fence,
            observedAt: NOW
          }
        }
      }
    ),
    releaseAcquisition: vi.fn(async () => true),
    dispatch: vi.fn(),
    cancelTurn: vi.fn(),
    answerPrompt: vi.fn(),
    setOption: vi.fn()
  }
  const ownerRead = vi.fn(
    async (params: AgentSessionAttachParams): Promise<'owned' | 'available' | 'unknown'> => {
      const handle = params.adopt?.providerHandle ?? params.providerHandle
      if (handle?.kind !== 'codex') {
        throw new Error('codex handle expected')
      }
      return registry.hasIdentityOwner(claimFor(handle.threadId)) ? 'owned' : 'available'
    }
  )
  const attach = (thread = THREAD) => {
    const transcriptPath = join(stateDirectory, `${thread}.jsonl`)
    const params: AgentSessionAttachParams = {
      envelope: {
        sessionId: `structured_${thread}`,
        clientOperationId: `${NOW}-${'1'.padStart(32, '0')}`,
        expectedRuntimeFence: null,
        payloadFingerprint: ''
      },
      location: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'workspace-1',
        workspaceKind: 'folder'
      },
      provider: 'codex',
      agent: 'codex',
      accountHome: { variable: 'CODEX_HOME', path: '/home/dev/.codex' },
      runtimeKind: 'native',
      adopt: { providerHandle: { kind: 'codex', threadId: thread }, transcriptPath }
    }
    params.envelope.payloadFingerprint = computeAgentSessionPayloadFingerprint({
      method: 'agentSession.attach',
      sessionId: params.envelope.sessionId,
      fields: attachFingerprintFields(params)
    })
    return performAttach({
      store,
      adapter,
      logger: createStructuredAgentSessionLogger(),
      openConversation: openTestAttachConversation(openTestJournalHostDatabase(stateDirectory)),
      onAttached: async ({ journal }) => {
        await journal.close()
      },
      authority: {
        spawnToken: `spawn:${thread}`,
        claimKeyId: signer.keyId,
        handoffOperationId: null,
        probe: { outcome: 'reservation-unused' }
      },
      callerKey: 'client',
      params,
      now: () => NOW,
      findTerminalAgentSessionOwner: ownerRead
    })
  }
  return {
    store,
    registry,
    claimFor,
    runtime,
    terminal,
    attach,
    adapter,
    ownerRead,
    spawnEntered,
    releaseSpawn,
    acquireEntered,
    failSpawn: () => {
      failSpawn = true
    },
    holdAcquire: (barrier: Promise<void>) => {
      acquireBarrier = barrier
    }
  }
}

describe('terminal RPC and structured attach conversation ownership', () => {
  it('waits for a terminal spawn, then refuses structured acquisition without writing a record', async () => {
    const r = await rig()
    const terminal = r.terminal()
    await r.spawnEntered.promise
    const structured = r.attach()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(r.ownerRead).not.toHaveBeenCalled()
    r.releaseSpawn.resolve()
    expect(await terminal).toMatchObject({ ok: true })
    expect(await structured).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_conflict' }
    })
    expect(r.adapter.acquire).not.toHaveBeenCalled()
    expect(r.store.listRecords()).toHaveLength(0)
  })

  it('refuses terminal resume after structured acquisition wins the same conversation', async () => {
    const r = await rig()
    const release = signal()
    r.holdAcquire(release.promise)
    const structured = r.attach()
    await r.acquireEntered.promise
    const terminal = r.terminal()
    expect(r.runtime.ensureAgentSession).not.toHaveBeenCalled()
    release.resolve()
    expect(await structured).toMatchObject({ ok: true })
    expect(await terminal).toMatchObject({ ok: false, error: { code: 'agent_session_conflict' } })
    expect(r.runtime.ensureAgentSession).not.toHaveBeenCalled()
  })

  it('allows structured acquisition after a failed terminal spawn releases the reservation', async () => {
    const r = await rig()
    r.failSpawn()
    const terminal = r.terminal()
    await r.spawnEntered.promise
    const structured = r.attach()
    r.releaseSpawn.resolve()
    expect(await terminal).toMatchObject({ ok: false })
    expect(await structured).toMatchObject({ ok: true })
    expect(r.adapter.acquire).toHaveBeenCalledTimes(1)
    expect(r.registry.find(r.claimFor(THREAD))).toBeNull()
  })

  it('does not block another conversation behind a pending terminal spawn', async () => {
    const r = await rig()
    const terminal = r.terminal()
    await r.spawnEntered.promise
    expect(await r.attach('independent-thread')).toMatchObject({ ok: true })
    r.releaseSpawn.resolve()
    expect(await terminal).toMatchObject({ ok: true })
  })

  it('refuses recovered terminal owners and permits acquisition only after release', async () => {
    const r = await rig()
    r.registry.register({
      claim: r.claimFor(THREAD),
      generation: 'recovered',
      phase: 'live',
      ptyId: 'recovered-pty',
      surface: { worktreeId: 'workspace-1', tabId: 'tab', leafId: 'leaf', terminalHandle: 'term' }
    })
    expect(await r.attach()).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_conflict' }
    })
    expect(r.adapter.acquire).not.toHaveBeenCalled()
    r.registry.release('recovered-pty', 'recovered')
    expect(await r.attach()).toMatchObject({ ok: true })
  })

  it('fails closed when terminal ownership cannot be verified', async () => {
    const r = await rig()
    r.ownerRead.mockResolvedValue('unknown')
    expect(await r.attach()).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_conflict' }
    })
    expect(r.adapter.acquire).not.toHaveBeenCalled()
    expect(r.store.listRecords()).toHaveLength(0)
  })

  it('loads structured records before checking a cold terminal resume', async () => {
    const r = await rig()
    expect(await r.attach()).toMatchObject({ ok: true })
    if (root) {
      closeTestJournalHostDatabase(root)
    }
    setStructuredAgentSessionHost(null)
    expect(await r.terminal()).toMatchObject({
      ok: false,
      error: { code: 'agent_session_conflict' }
    })
    expect(r.runtime.ensureStructuredAgentSessionHost).toHaveBeenCalledTimes(1)
    expect(r.runtime.ensureAgentSession).not.toHaveBeenCalled()
  })
})
