import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { wslHookRelayConnectionId } from '../../../../shared/agent-hook-listener/transport/wsl-hook-relay-contract'
import { getDefaultWorkspaceSession } from '../../../../shared/orca-profiles/constants'
import { claudeProviderHandle } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import type { ResumeSpawnArgs } from './saved-resume-admission'
import type { RuntimePtyController } from '../../../runtime/terminal/lifecycle/runtime-pty-controller-contract'

await import('../../../runtime/orca-runtime-tests/runtime-test-module-registration.spec')
await import('../../../runtime/orca-runtime-tests/orca-runtime-test-lifecycle.spec')
const { OrcaRuntimeService } = await import('../../../runtime/orca-runtime')
const { AgentHookServer } = await import('../../../agent-hooks/server/agent-hook-server')
const { retireRestoredStatusesWithDeadTerminals } =
  await import('../../../agent-hooks/observations/restored-status-dead-terminal-sweep')
const { makeRuntimeStoreWithWorkspaceSession } =
  await import('../../../runtime/orca-runtime-tests/orca-runtime-test-fixtures.spec')
const { openTestAgentSessionRecordStore, closeTestAgentSessionDatabase } =
  await import('../../../runtime/agent-session/records/agent-session-record-store-test-harness')
const { chooseSavedResumeFreshLaunch, admitColdRestoreReattach, savedResumeResult } =
  await import('./saved-resume-admission')

const LIVE_PANE = 'live-tab:11111111-1111-4111-8111-111111111111'
const RESTORED_PANE = 'restored-tab:22222222-2222-4222-8222-222222222222'
const servers: InstanceType<typeof AgentHookServer>[] = []
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop()
  }
})

function fixture(
  options: {
    agent?: 'claude' | 'codex'
    connectionId?: string | null
    wslDistro?: string | null
    registered?: boolean
    beforeFirstHook?: boolean
  } = {}
) {
  const agent = options.agent ?? 'claude'
  const server = new AgentHookServer()
  servers.push(server)
  const remote = (ended = false, distro = options.wslDistro) =>
    server.ingestRemote(
      {
        paneKey: LIVE_PANE,
        worktreeId: 'folder-workspace',
        providerSession: { key: 'session_id', id: 'conversation-s' },
        agentPresence: {
          agent,
          process: { pid: 4001, platform: 'linux', startTime: 'birth-4001' },
          ...(ended ? { ended: true } : {})
        },
        payload: { state: 'done', prompt: '', agentType: agent }
      },
      distro ? wslHookRelayConnectionId(distro) : (options.connectionId ?? null)
    )
  if (!options.beforeFirstHook && (options.connectionId || options.wslDistro)) {
    remote()
  } else {
    server.recordLaunchResumeIdentity({
      paneKey: LIVE_PANE,
      worktreeId: 'folder-workspace',
      agentType: agent,
      providerSession: { key: 'session_id', id: 'conversation-s' },
      launchedAt: 1
    })
  }
  const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(getDefaultWorkspaceSession())
  const runtime = new OrcaRuntimeService(runtimeStore, undefined, {
    getAgentProviderSessionSnapshot: () => server.getStatusSnapshot(),
    readHookCliWriterObservation: (row) => server.readCliWriterObservation(row)
  })
  const probe = { read: async (): Promise<boolean | null> => true }
  const controller: RuntimePtyController = {
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    probePtyLiveness: () => probe.read()
  }
  runtime.setPtyController(controller)
  if (options.registered !== false) {
    runtime.registerPty('pty-a', 'folder-workspace', options.connectionId ?? null, {
      tabId: 'live-tab',
      leafId: '11111111-1111-4111-8111-111111111111',
      incarnationId: 'incarnation-a'
    })
  }
  if (options.wslDistro) {
    runtime.preparePtyExecutionContext('pty-a', options.wslDistro)
  }
  const attempt = async (
    overrides: Partial<ResumeSpawnArgs> = {},
    distro = options.wslDistro ?? null
  ) => {
    const args: ResumeSpawnArgs = {
      resumeOrigin: 'saved',
      spawnIntent: 'automatic-restore',
      launchAgent: agent,
      resumeProviderSession: { key: 'session_id', id: 'conversation-s' },
      command: `${agent} --resume conversation-s`,
      connectionId: options.connectionId ?? null,
      ...overrides
    }
    const spawnOptions = {
      ...args,
      startupCommandDelivery: { mode: 'write' },
      startupIngress: { kind: 'agent' }
    }
    const admission = await chooseSavedResumeFreshLaunch(runtime, args, distro, spawnOptions)
    return { admission, args, spawnOptions }
  }
  return { runtime, server, probe, controller, attempt, remote }
}

describe('automatic saved provider-session resume admission', () => {
  it('admits another resume after the sweep proves a restored owner absent and its pane gets a shell', async () => {
    const f = fixture({ registered: false })
    const directory = await mkdtemp(join(tmpdir(), 'orca-swept-resume-'))
    try {
      await mkdir(join(directory, 'agent-hooks'))
      await writeFile(
        join(directory, 'agent-hooks', 'last-status.json'),
        JSON.stringify({
          version: 2,
          entries: {
            [LIVE_PANE]: {
              paneKey: LIVE_PANE,
              tabId: 'live-tab',
              worktreeId: 'folder-workspace',
              connectionId: null,
              receivedAt: 4_102_444_800_000,
              stateStartedAt: 4_102_444_800_000,
              providerSession: { key: 'session_id', id: 'conversation-s' },
              payload: { state: 'working', prompt: '', agentType: 'claude' }
            }
          }
        })
      )
      await f.server.start({ env: 'production', userDataPath: directory })
      await retireRestoredStatusesWithDeadTerminals({
        server: f.server,
        probePtyLiveness: async () => false,
        isLocalExecutionHost: () => true,
        getBoundPtyIdForPaneKey: () => undefined,
        getPersistedPtyIdForPaneKey: () => 'old-pty'
      })
      f.runtime.registerPty('plain-shell', 'folder-workspace', null, {
        tabId: 'live-tab',
        leafId: '11111111-1111-4111-8111-111111111111',
        incarnationId: 'shell-incarnation'
      })
      const resumed = await f.attempt()
      expect(resumed.admission?.verdict).toBe('admitted')
      expect(resumed.spawnOptions.command).toBe('claude --resume conversation-s')
    } finally {
      f.server.stop()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('blocks a live identity-only owner, but releases a confirmed ended agent whose shell survives', async () => {
    const f = fixture()
    const blocked = await f.attempt()
    expect(blocked.spawnOptions.command).toBeUndefined()
    f.server.dropStatusEntry(LIVE_PANE)
    expect((await f.attempt()).spawnOptions.command).toBeUndefined()
    f.server.reconcileEndedProcessForPaneKeys([LIVE_PANE], {
      preserveResumeIdentity: true,
      processExitConfirmed: true
    })
    f.probe.read = async () => {
      throw new Error('owner unreachable')
    }
    expect((await f.attempt()).spawnOptions.command).toBe('claude --resume conversation-s')
    const absent = fixture({ registered: false })
    expect((await absent.attempt()).spawnOptions.command).toBe('claude --resume conversation-s')
  })

  it.each([
    { processExitConfirmed: true },
    { endedPresence: { agent: 'claude', ended: true as const } }
  ])('requires exit proof before a shell reconcile releases ownership: %j', async (proof) => {
    const f = fixture()
    f.server.reconcileEndedProcessForPaneKeys([LIVE_PANE], { preserveResumeIdentity: true })
    expect((await f.attempt()).admission?.verdict).toBe('unverifiable')
    f.server.reconcileEndedProcessForPaneKeys([LIVE_PANE], {
      preserveResumeIdentity: true,
      ...proof
    })
    expect((await f.attempt()).admission?.verdict).toBe('admitted')
  })

  it('keeps a Codex conversation reserved on an unknown probe until absence is confirmed', async () => {
    const f = fixture({ agent: 'codex' })
    f.probe.read = async () => null
    expect((await f.attempt()).spawnOptions.command).toBeUndefined()
    f.probe.read = async () => false
    expect((await f.attempt()).spawnOptions.command).toBe('codex --resume conversation-s')
  })

  it('releases a remote owner on its own ended report even when its PTY cannot be probed', async () => {
    const f = fixture({ connectionId: 'remote-host' })
    f.probe.read = async () => null
    expect((await f.attempt()).spawnOptions.command).toBeUndefined()
    expect((await f.attempt({ connectionId: null })).spawnOptions.command).toBe(
      'claude --resume conversation-s'
    )
    f.remote(true)
    f.probe.read = async () => {
      throw new Error('remote disconnected')
    }
    expect((await f.attempt()).spawnOptions.command).toBe('claude --resume conversation-s')
  })

  it('exempts an explicit user-resume intent even when its resume origin is saved', async () => {
    const f = fixture()
    expect((await f.attempt()).spawnOptions.command).toBeUndefined()
    const explicit = await f.attempt({ spawnIntent: 'user-resume' })
    expect(explicit.admission?.verdict).toBe('admitted')
    expect(explicit.spawnOptions.command).toBe('claude --resume conversation-s')
  })

  it('keeps WSL ownership within its distribution before and after the first hook', async () => {
    const f = fixture({ agent: 'codex', wslDistro: 'Ubuntu', beforeFirstHook: true })
    expect((await f.attempt()).spawnOptions.command).toBeUndefined()
    expect((await f.attempt({}, 'Debian')).spawnOptions.command).toBe(
      'codex --resume conversation-s'
    )
    expect((await f.attempt({}, null)).spawnOptions.command).toBe('codex --resume conversation-s')
    f.probe.read = async () => {
      f.remote(false, 'ubuntu')
      return true
    }
    expect((await f.attempt()).spawnOptions.command).toBeUndefined()
    f.probe.read = async () => true
    expect((await f.attempt({}, 'Debian')).spawnOptions.command).toBe(
      'codex --resume conversation-s'
    )
    expect((await f.attempt({}, null)).spawnOptions.command).toBe('codex --resume conversation-s')
    f.remote(true, 'ubuntu')
    expect((await f.attempt()).spawnOptions.command).toBe('codex --resume conversation-s')
    const native = fixture()
    expect((await native.attempt({}, 'Ubuntu')).spawnOptions.command).toBe(
      'claude --resume conversation-s'
    )
  })

  it('refuses cold restore while another owner exists, excluding the newly restored shell itself', async () => {
    const f = fixture()
    f.server.recordLaunchResumeIdentity({
      paneKey: RESTORED_PANE,
      worktreeId: 'folder-workspace',
      agentType: 'claude',
      providerSession: { key: 'session_id', id: 'conversation-s' },
      launchedAt: 1
    })
    f.runtime.registerPty('restored-shell', 'folder-workspace', null, {
      tabId: 'restored-tab',
      leafId: '22222222-2222-4222-8222-222222222222',
      incarnationId: 'new-shell'
    })
    const restore = () =>
      admitColdRestoreReattach(
        f.runtime,
        { id: 'restored-shell', coldRestore: {} },
        {
          paneKey: RESTORED_PANE,
          saved: {
            paneKey: RESTORED_PANE,
            worktreeId: 'folder-workspace',
            agent: 'claude',
            providerSession: { key: 'session_id', id: 'conversation-s' },
            state: 'done',
            prompt: '',
            capturedAt: 1,
            updatedAt: 1
          }
        },
        null
      )
    expect(savedResumeResult(await restore())).toMatchObject({
      agentResumeUnavailable: true,
      agentResumeRefused: 'unverifiable'
    })
    f.server.reconcileEndedProcessForPaneKeys([LIVE_PANE], {
      preserveResumeIdentity: true,
      processExitConfirmed: true
    })
    expect((await restore())?.verdict).toBe('admitted')
  })

  it('admits cold restore when the owner switches to the restoring PTY during the probe', async () => {
    const f = fixture()
    f.probe.read = async () => {
      await f.runtime.onPtyExit('pty-a', 0, 'incarnation-a')
      f.runtime.registerPty('restored-shell', 'folder-workspace', null, {
        tabId: 'live-tab',
        leafId: '11111111-1111-4111-8111-111111111111',
        incarnationId: 'new-shell'
      })
      return true
    }
    const admission = await admitColdRestoreReattach(
      f.runtime,
      { id: 'restored-shell', coldRestore: {} },
      {
        paneKey: LIVE_PANE,
        saved: {
          paneKey: LIVE_PANE,
          worktreeId: 'folder-workspace',
          agent: 'claude',
          providerSession: { key: 'session_id', id: 'conversation-s' },
          state: 'done',
          prompt: '',
          capturedAt: 1,
          updatedAt: 1
        }
      },
      null
    )
    expect(admission?.verdict).toBe('admitted')
  })

  it('refuses cold restore when its saved conversation differs from the unheld active row', async () => {
    const f = fixture()
    f.server.recordLaunchResumeIdentity({
      paneKey: RESTORED_PANE,
      worktreeId: 'folder-workspace',
      agentType: 'claude',
      providerSession: { key: 'session_id', id: 'conversation-a' },
      launchedAt: 1
    })
    f.server.ingestTerminalStatus({
      paneKey: RESTORED_PANE,
      payload: { state: 'working', prompt: '', agentType: 'claude' }
    })
    f.runtime.registerPty('restored-shell', 'folder-workspace', null, {
      tabId: 'restored-tab',
      leafId: '22222222-2222-4222-8222-222222222222',
      incarnationId: 'new-shell'
    })
    const admission = await admitColdRestoreReattach(
      f.runtime,
      { id: 'restored-shell', coldRestore: {} },
      {
        paneKey: RESTORED_PANE,
        saved: {
          paneKey: RESTORED_PANE,
          worktreeId: 'folder-workspace',
          agent: 'claude',
          providerSession: { key: 'session_id', id: 'conversation-s' },
          state: 'done',
          prompt: '',
          capturedAt: 1,
          updatedAt: 1
        }
      },
      null
    )
    expect(admission).toMatchObject({
      verdict: 'unverifiable',
      refused: { agent: 'claude', providerSession: { key: 'session_id', id: 'conversation-s' } }
    })
  })

  it('keeps a non-first native-chat refusal unverifiable while preserving first-candidate verdicts', async () => {
    const f = fixture({ registered: false })
    const directory = await mkdtemp(join(tmpdir(), 'orca-chat-resume-'))
    try {
      const store = await openTestAgentSessionRecordStore(directory)
      await store.reserveOwner({
        sessionId: 'native-chat-s',
        location: {
          executionHostId: 'local',
          wslDistro: null,
          workspaceId: 'folder-workspace',
          workspaceKind: 'folder'
        },
        provider: 'claude',
        accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: join(tmpdir(), 'claude-resume-test') },
        adoptedHandleLink: {
          linkId: 'chat-link-s',
          handle: claudeProviderHandle('conversation-s', null),
          origin: 'adopted',
          mintedAtFence: 1,
          observedAt: 1_800_000_000_000
        },
        expectedFence: null,
        spawnToken: 'chat-spawn',
        claimKeyId: 'chat-key',
        handoffOperationId: null,
        probe: { outcome: 'indeterminate', reason: 'new chat' },
        operation: {
          callerKey: 'test-client',
          operationId: '1800000000000-00000000000000000000000000000001',
          fingerprint: 'native-chat-s'
        },
        now: 1_800_000_000_000
      })
      await store.evictProvenDeadOwner({
        sessionId: 'native-chat-s',
        expectedFence: 1,
        probe: { outcome: 'reservation-unused' },
        now: 1_800_000_060_000
      })
      await store.setSessionTabVisibility('native-chat-s', true)
      const saved = {
        paneKey: RESTORED_PANE,
        worktreeId: 'folder-workspace',
        agent: 'claude' as const,
        providerSession: { key: 'session_id' as const, id: 'conversation-s' },
        state: 'done' as const,
        prompt: '',
        capturedAt: 1,
        updatedAt: 1
      }
      const restore = () =>
        admitColdRestoreReattach(
          {
            getAgentProviderSessionRows: () => f.runtime.getAgentProviderSessionRows(),
            isTerminalProviderSessionHeld: (...args) =>
              f.runtime.isTerminalProviderSessionHeld(...args),
            openAgentSessionRecordStore: async () => store
          },
          { id: 'restored-shell', coldRestore: {} },
          { paneKey: RESTORED_PANE, saved },
          null
        )
      expect((await restore())?.verdict).toBe('chat-home')
      f.server.recordLaunchResumeIdentity({
        paneKey: RESTORED_PANE,
        worktreeId: 'folder-workspace',
        agentType: 'claude',
        providerSession: { key: 'session_id', id: 'conversation-x' },
        launchedAt: 1
      })
      f.server.ingestTerminalStatus({
        paneKey: RESTORED_PANE,
        payload: { state: 'working', prompt: '', agentType: 'claude' }
      })
      expect(await restore()).toMatchObject({
        verdict: 'unverifiable',
        refused: { agent: 'claude', providerSession: { key: 'session_id', id: 'conversation-s' } }
      })
    } finally {
      await closeTestAgentSessionDatabase(directory)
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.each([
    ['pty-b', 'incarnation-b', true],
    ['pty-b', 'incarnation-b', false],
    ['pty-a', 'incarnation-b', true],
    ['pty-a', 'incarnation-b', false]
  ] as const)(
    'refuses a replacement PTY during the probe: %s %s %s',
    async (ptyId, incarnationId, live) => {
      const f = fixture()
      f.probe.read = async () => {
        await f.runtime.onPtyExit('pty-a', 0, 'incarnation-a')
        f.runtime.registerPty(ptyId, 'folder-workspace', null, {
          tabId: 'live-tab',
          leafId: '11111111-1111-4111-8111-111111111111',
          incarnationId
        })
        return live
      }
      expect((await f.attempt()).admission?.verdict).toBe('unverifiable')
    }
  )

  it('keeps ownership across a turn update during the probe, then releases on an exit overtaking a probe', async () => {
    const f = fixture()
    expect((await f.attempt()).spawnOptions.command).toBeUndefined()
    f.probe.read = async () => {
      f.server.ingestTerminalStatus({
        paneKey: LIVE_PANE,
        payload: { state: 'working', prompt: 'next', agentType: 'claude' }
      })
      return true
    }
    expect((await f.attempt()).spawnOptions.command).toBeUndefined()
    f.probe.read = async () => {
      await f.runtime.onPtyExit('pty-a', 0, 'incarnation-a')
      return true
    }
    expect((await f.attempt()).spawnOptions.command).toBe('claude --resume conversation-s')
  })
})
