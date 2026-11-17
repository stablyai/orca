import { afterEach, describe, expect, it } from 'vitest'
import { wslHookRelayConnectionId } from '../../../../shared/agent-hook-listener/transport/wsl-hook-relay-contract'
import { getDefaultWorkspaceSession } from '../../../../shared/orca-profiles/constants'
import type { ResumeSpawnArgs } from './saved-resume-admission'
import type { RuntimePtyController } from '../../../runtime/terminal/lifecycle/runtime-pty-controller-contract'

await import('../../../runtime/orca-runtime-tests/runtime-test-module-registration.spec')
await import('../../../runtime/orca-runtime-tests/orca-runtime-test-lifecycle.spec')
const { OrcaRuntimeService } = await import('../../../runtime/orca-runtime')
const { AgentHookServer } = await import('../../../agent-hooks/server/agent-hook-server')
const { makeRuntimeStoreWithWorkspaceSession } =
  await import('../../../runtime/orca-runtime-tests/orca-runtime-test-fixtures.spec')
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
  it('blocks a live identity-only owner, but releases a confirmed ended agent whose shell survives', async () => {
    const f = fixture()
    const blocked = await f.attempt()
    expect(blocked.spawnOptions.command).toBeUndefined()
    f.server.dropStatusEntry(LIVE_PANE)
    expect((await f.attempt()).spawnOptions.command).toBeUndefined()
    f.server.reconcileEndedProcessForPaneKeys([LIVE_PANE], { preserveResumeIdentity: true })
    f.probe.read = async () => {
      throw new Error('owner unreachable')
    }
    expect((await f.attempt()).spawnOptions.command).toBe('claude --resume conversation-s')
    const absent = fixture({ registered: false })
    expect((await absent.attempt()).spawnOptions.command).toBe('claude --resume conversation-s')
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
    f.server.reconcileEndedProcessForPaneKeys([LIVE_PANE], { preserveResumeIdentity: true })
    expect((await restore())?.verdict).toBe('admitted')
  })

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
