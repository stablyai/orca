import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import type { AgentSessionProviderHandleLink } from '../../shared/agent-session-provider-handle'
import { agentSessionProviderHandleKey } from '../../shared/agent-session-provider-handle'
import { closeTestJournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { openTestAgentSessionRecordStore } from '../runtime/agent-session-record-store-test-harness'
import { buildPiRpcLaunch } from './rpc-launch'
import { createPiRpcLaunchResolver, piRpcProviderLink } from './rpc-launch-resolution'

const probeVersion = vi.fn(async (..._input: unknown[]) => true)

const identity: AgentSessionJournalIdentity = {
  sessionId: 'session-pi-resolve',
  workspaceId: 'folder-1',
  hostId: 'local',
  agent: 'pi',
  providerHandle: null
}
let root: string
beforeEach(async () => {
  probeVersion.mockReset().mockResolvedValue(true)
  root = await mkdtemp(join(tmpdir(), 'orca-pi-resolver-'))
})
afterEach(async () => {
  closeTestJournalHostDatabase(root)
  await rm(root, { recursive: true, force: true })
})

async function setup() {
  const store = await openTestAgentSessionRecordStore(root)
  const { record } = await store.reserveOwner({
    sessionId: identity.sessionId,
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'folder-1',
      workspaceKind: 'folder'
    },
    provider: 'pi',
    accountHome: { variable: 'PI_CODING_AGENT_DIR', path: '/host/account' },
    expectedFence: null,
    spawnToken: 'spawn-pi',
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: { outcome: 'reservation-unused' },
    operation: {
      callerKey: 'client-1',
      operationId: '1800000000000-00000000000000000000000000000001',
      fingerprint: 'pi-create'
    },
    now: 1_800_000_000_000
  })
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const resolveEnvironment = vi.fn(async () => ({
    PATH: '/host/bin',
    HOME: '/host/home',
    PI_CODING_AGENT_DIR: '/inherited/wrong'
  }))
  const resolveCommand = vi.fn((..._input: unknown[]) => '/host/bin/pi')
  const settings: { agentCmdOverrides: Record<string, string> } = { agentCmdOverrides: {} }
  const resolver = createPiRpcLaunchResolver({
    store,
    resolveWorkspacePath: async () => workspace,
    resolveEnvironment,
    resolveCommandSettings: () => settings,
    resolveCommand,
    probeVersion
  })
  const prior = (
    file: string,
    origin: AgentSessionProviderHandleLink['origin'] = 'created'
  ): AgentSessionProviderHandleLink => ({
    linkId: 'prior-link',
    handle: { transport: 'jsonl-rpc', agent: 'pi', nativeId: file },
    origin,
    mintedAtFence: 1,
    observedAt: 100
  })
  const withPrior = (link: AgentSessionProviderHandleLink) => {
    vi.spyOn(store, 'getRecord').mockReturnValue({ ...record, providerHandleChain: [link] })
  }
  return { store, record, workspace, resolver, resolveCommand, settings, prior, withPrior }
}

describe('Pi host launch resolution', () => {
  it('refuses acquisition if the selected binary was replaced by an unsupported version', async () => {
    const h = await setup()
    probeVersion.mockResolvedValue(false)
    await expect(h.resolver(identity)).rejects.toThrow('structured_agent_session_unsupported')
    expect(probeVersion).toHaveBeenCalledWith(
      {
        program: '/host/bin/pi',
        cwd: h.workspace,
        env: { PATH: '/host/bin', HOME: '/host/home', PI_CODING_AGENT_DIR: '/host/account' }
      },
      expect.any(Function)
    )
  })

  it('uses the runtime workspace, binary and account home for a new folder session', async () => {
    const h = await setup()
    const launch = await h.resolver(identity)
    expect(launch).toMatchObject({
      command: '/host/bin/pi',
      cwd: h.workspace,
      env: { PATH: '/host/bin', HOME: '/host/home', PI_CODING_AGENT_DIR: '/host/account' },
      previous: null,
      fullAccess: true
    })
    expect(h.resolveCommand).toHaveBeenCalledWith('pi', {
      pathEnv: '/host/bin',
      homePath: '/host/home'
    })
  })

  it('starts a fresh session after clear without reading the previous file', async () => {
    const h = await setup()
    const old = join(root, 'old-malformed.jsonl')
    await writeFile(old, 'not a Pi session header')
    vi.spyOn(h.store, 'getRecord').mockReturnValue({
      ...h.record,
      providerHandleChain: [],
      providerContextBoundary: { operationId: 'clear', afterFence: 2, clearedAt: 100 }
    })
    const launch = await h.resolver({ ...identity, providerHandle: h.prior(old).handle })
    expect(launch.previous).toBeNull()
    expect(launch.sessionFile).toBeUndefined()
    expect(launch.forkFile).toBeUndefined()
    expect(launch.replacement).toBeUndefined()
    expect(buildPiRpcLaunch(launch).args).toEqual(['--mode', 'rpc'])
    expect(piRpcProviderLink(launch, join(root, 'fresh.jsonl'), 3, 'fresh', 101).origin).toBe(
      'created'
    )
  })

  it('spawns the binary the Command setting names, and refuses one that is not runnable', async () => {
    const h = await setup()
    h.settings.agentCmdOverrides = { pi: `"${process.execPath}"` }
    await expect(h.resolver(identity)).resolves.toMatchObject({ command: process.execPath })
    expect(h.resolveCommand).not.toHaveBeenCalled()

    probeVersion.mockClear()
    h.settings.agentCmdOverrides = { pi: '/missing/pi' }
    await expect(h.resolver(identity)).rejects.toMatchObject({
      reason: 'agentCommandNotRunnable'
    })
    expect(probeVersion).not.toHaveBeenCalled()
  })

  it('resumes the same directory and forks a session from a different directory', async () => {
    const h = await setup()
    const same = join(root, 'same.jsonl')
    await writeFile(same, `${JSON.stringify({ type: 'session', cwd: h.workspace })}\n`)
    h.withPrior(h.prior(same))
    const resumed = await h.resolver(identity)
    expect(resumed.sessionFile).toBe(same)
    expect(resumed.forkFile).toBeUndefined()
    expect(piRpcProviderLink(resumed, same, 2, 'next', 200).origin).toBe('resumed')
    expect(() => piRpcProviderLink(resumed, join(root, 'wrong.jsonl'), 2, 'bad', 200)).toThrow(
      'different session file'
    )

    const elsewhere = join(root, 'elsewhere.jsonl')
    await writeFile(elsewhere, `${JSON.stringify({ type: 'session', cwd: join(root, 'other') })}\n`)
    h.withPrior(h.prior(elsewhere))
    const forked = await h.resolver(identity)
    expect(forked.forkFile).toBe(elsewhere)
    expect(forked.sessionFile).toBeUndefined()
    expect(piRpcProviderLink(forked, join(root, 'fork.jsonl'), 2, 'fork', 200)).toMatchObject({
      origin: 'forked',
      forkedFromKey: agentSessionProviderHandleKey(h.prior(elsewhere).handle)
    })
    expect(() => piRpcProviderLink(forked, elsewhere, 2, 'bad', 200)).toThrow('did not fork')
  })

  it('resumes the stored session file after Orca restarts and reopens the store', async () => {
    const h = await setup()
    const file = join(root, 'conversation.jsonl')
    await writeFile(file, `${JSON.stringify({ type: 'session', cwd: h.workspace })}\n`)
    const fence = h.record.lease.runtimeFence
    await h.store.commitProcessIdentity({
      sessionId: identity.sessionId,
      fence,
      process: { hostId: 'local', pid: 4242, processStartTimeMs: 1, spawnToken: 'spawn-pi' },
      now: 1_800_000_000_001
    })
    await h.store.proveOwner({
      sessionId: identity.sessionId,
      fence,
      link: { ...h.prior(file), mintedAtFence: fence },
      now: 1_800_000_000_002
    })
    // A restart: the store is closed and a fresh one reads the record back from disk.
    closeTestJournalHostDatabase(root)
    const reopened = await openTestAgentSessionRecordStore(root)
    const launch = await createPiRpcLaunchResolver({
      store: reopened,
      resolveWorkspacePath: async () => h.workspace,
      resolveEnvironment: async () => ({ PATH: '/host/bin', HOME: '/host/home' }),
      resolveCommand: () => '/host/bin/pi',
      probeVersion
    })(identity)
    expect(launch.sessionFile).toBe(file)
    expect(buildPiRpcLaunch(launch).args).toEqual(['--mode', 'rpc', '--session', file])
  })

  it('distinguishes an unsaved creation from an existing session that could not restore', async () => {
    const h = await setup()
    const missing = join(root, 'missing.jsonl')
    h.withPrior(h.prior(missing))
    const unsaved = await h.resolver(identity)
    expect(unsaved.replacement).toBe('unsaved')
    expect(piRpcProviderLink(unsaved, join(root, 'new.jsonl'), 2, 'new', 200)).toMatchObject({
      origin: 'created',
      supersedesKey: agentSessionProviderHandleKey(h.prior(missing).handle)
    })
    h.withPrior(h.prior(missing, 'resumed'))
    const lost = await h.resolver(identity)
    expect(lost.replacement).toBe('restore-failed')
    expect(
      piRpcProviderLink(lost, join(root, 'replacement.jsonl'), 2, 'replace', 200)
    ).toMatchObject({ replaces: { reason: 'restore-failed', replacedAt: 200 } })
  })

  it('refuses a different execution host and a foreign account home before resolving paths', async () => {
    const h = await setup()
    const record = h.store.getRecord(identity.sessionId)
    if (!record) {
      throw new Error('record missing')
    }
    vi.spyOn(h.store, 'getRecord').mockReturnValue({
      ...record,
      location: { ...record.location, executionHostId: 'ssh:remote' }
    })
    await expect(h.resolver(identity)).rejects.toThrow('another execution host')
    vi.spyOn(h.store, 'getRecord').mockReturnValue({
      ...record,
      accountHome: { variable: 'CODEX_HOME', path: '/wrong' }
    })
    await expect(h.resolver(identity)).rejects.toThrow('account home')
    expect(h.resolveCommand).not.toHaveBeenCalled()
  })
})
