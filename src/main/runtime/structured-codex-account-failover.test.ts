import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStructuredAgentSessionOperationId } from '../../shared/structured-agent-session-mutation'
import type { CodexManagedAccount } from '../../shared/managed-account-types'
import type { CodexAccountFailoverInput } from '../codex-accounts/codex-account-failover'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { AgentSessionRecordStore } from './agent-session-record-store'
import { StructuredCodexAccountFailover } from './structured-codex-account-failover'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(seamless = true) {
  const root = await mkdtemp(join(tmpdir(), 'orca-native-failover-'))
  roots.push(root)
  const home = join(root, 'a')
  const target = join(root, 'b')
  const threadId = '01234567-89ab-cdef-0123-456789abcdef'
  const suffix = join('sessions', '2026', '09', '17', `rollout-${threadId}.jsonl`)
  const transcript = join(home, suffix)
  await mkdir(dirname(transcript), { recursive: true })
  const acceptedWork = `${[
    { type: 'session_meta', payload: { id: threadId } },
    {
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'accepted-tool', output: 'completed' }
    }
  ]
    .map((event) => JSON.stringify(event))
    .join('\n')}\n`
  await writeFile(transcript, acceptedWork)
  const store = await AgentSessionRecordStore.open({
    directory: join(root, 'records'),
    hostId: 'local'
  })
  const now = Date.now()
  await store.reserveOwner({
    sessionId: 'session-test',
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'folder',
      workspaceKind: 'folder'
    },
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: home },
    runtimeKind: 'native',
    expectedFence: null,
    spawnToken: 'spawn-test',
    claimKeyId: 'key-test',
    handoffOperationId: null,
    probe: { outcome: 'reservation-unused' },
    operation: {
      callerKey: 'test',
      operationId: createStructuredAgentSessionOperationId(randomUUID, now),
      fingerprint: 'test'
    },
    now
  })
  const original = await store.transitionHandoff('session-test', (record) => ({
    ...record,
    options: { model: 'gpt-user-model', effort: 'high' },
    providerHandleChain: [
      {
        linkId: 'link-test',
        handle: { provider: 'codex', threadId },
        origin: 'created',
        mintedAtFence: record.lease.runtimeFence,
        observedAt: now
      }
    ]
  }))
  const account: CodexManagedAccount = {
    id: 'b',
    email: 'b@example.test',
    managedHomePath: target,
    createdAt: now,
    updatedAt: now,
    lastAuthenticatedAt: now
  }
  const failover = vi.fn(async (input: CodexAccountFailoverInput) => {
    await input.migrate(account, () => true)
    return true
  })
  const reportFailure = vi.fn()
  const send = vi.fn<StructuredAgentSessionHost['send']>(async (_caller, params) => {
    params.beforeRun?.()
    return { ok: false, refusal: { code: 'agent_session_ownership_unknown', message: 'fake host' } }
  })
  const coordinator = new StructuredCodexAccountFailover({
    store,
    accounts: () => ({ failover, automation: { reportFailure } }),
    seamless: () => seamless,
    host: () => ({ send })
  })
  const input = {
    sessionId: original.sessionId,
    home,
    threadId,
    historyPath: transcript,
    fence: original.lease.runtimeFence,
    signal: new AbortController().signal,
    isSafe: () => true,
    stop: vi.fn(async () => true)
  }
  return {
    coordinator,
    input,
    original,
    store,
    send,
    failover,
    reportFailure,
    target,
    suffix,
    acceptedWork
  }
}

describe('same-conversation account migration', () => {
  it('retains provider identity, completed tool output, and the user model while repinning the account durably', async () => {
    const f = await fixture()
    expect(await f.coordinator.failover(f.input)).toBe(true)
    const record = f.store.getRecord(f.input.sessionId)
    expect(record?.accountHome.path).toBe(f.target)
    expect(record?.providerHandleChain).toEqual(f.original.providerHandleChain)
    expect(record?.options).toEqual({ model: 'gpt-user-model', effort: 'high' })
    expect(await readFile(join(f.target, f.suffix), 'utf8')).toBe(f.acceptedWork)
    expect(f.input.stop).toHaveBeenCalledOnce()
    expect(f.send).not.toHaveBeenCalled()
  })
  it('submits one new continuation only after recovery, never the accepted request', async () => {
    const f = await fixture()
    await f.coordinator.failover(f.input)
    await f.coordinator.recovered(f.input.sessionId)
    await f.coordinator.recovered(f.input.sessionId)
    expect(f.send).toHaveBeenCalledOnce()
    expect(f.send.mock.calls[0][1].envelope.clientOperationId).toMatch(/^\d{13}-[a-f0-9]{32}$/)
    expect(f.send.mock.calls[0][1].body.blocks).toEqual([
      {
        type: 'text',
        text: 'Continue from the interrupted turn. Preserve completed work and do not repeat completed tool actions.'
      }
    ])
  })
  it('leaves safe mode paused after migration', async () => {
    const f = await fixture(false)
    await f.coordinator.failover(f.input)
    await f.coordinator.recovered(f.input.sessionId)
    expect(f.send).not.toHaveBeenCalled()
  })
  it('lets a foreground request cancel automatic continuation', async () => {
    const f = await fixture()
    await f.coordinator.failover(f.input)
    await f.coordinator.dispatched(f.input.sessionId, 'manual-message')
    await f.coordinator.recovered(f.input.sessionId)
    expect(f.send).not.toHaveBeenCalled()
    expect(f.store.getRecord(f.input.sessionId)?.codexFailoverHomes).toEqual([])
  })
  it('does not repin when exit cannot be proven', async () => {
    const f = await fixture()
    f.input.stop.mockResolvedValue(false)
    await expect(f.coordinator.failover(f.input)).rejects.toThrow('unverifiable')
    expect(f.store.getRecord(f.input.sessionId)?.accountHome.path).toBe(f.input.home)
    expect(f.send).not.toHaveBeenCalled()
  })
  it('refuses a divergent copy of the same transcript before stopping the original', async () => {
    const f = await fixture()
    await mkdir(dirname(join(f.target, f.suffix)), { recursive: true })
    await writeFile(join(f.target, f.suffix), f.acceptedWork)
    await expect(f.coordinator.failover(f.input)).rejects.toThrow('different writer')
    expect(f.input.stop).not.toHaveBeenCalled()
  })
  it('keeps database-backed provider history intact instead of treating a rollout as its complete history', async () => {
    const f = await fixture()
    expect(await f.coordinator.failover({ ...f.input, historyMode: 'paginated' })).toBe(false)
    expect(f.failover).not.toHaveBeenCalled()
    expect(f.input.stop).not.toHaveBeenCalled()
    expect(f.reportFailure).toHaveBeenCalledOnce()
  })
})
