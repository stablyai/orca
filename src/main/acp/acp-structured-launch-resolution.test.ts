import type { JournalLoad } from '../native-chat/agent-session-journal/journal-open'
import { createAcpStructuredLaunchResolver } from '../runtime/structured-agent-launch-composition.test-support'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import { agentSessionProviderHandleKey } from '../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import type { AgentSessionProviderHandle } from '../../shared/agent-session/lifecycle/agent-session-provider-handle'
import type { AgentSessionRecord } from '../../shared/agent-session/lifecycle/agent-session-record'
import { agentSessionRecordFixture } from '../../shared/agent-session/lifecycle/agent-session-record.test-fixture'
import { createProviderSpawnSpec } from '../provider-process/provider-process-supervisor'
import { acpLaunchSpecFor } from './acp-launch-specs'
import { STRUCTURED_CHILD_ENV_TO_DELETE } from '../runtime/structured-session-child-env'

const GROK = acpLaunchSpecFor('grok')!
const identity = {
  sessionId: 'session-alpha-1',
  workspaceId: 'workspace-1',
  hostId: 'local',
  agent: 'grok',
  providerHandle: null
}

function grokRecord(overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord {
  return {
    ...agentSessionRecordFixture(),
    provider: 'grok',
    providerHandleChain: [],
    accountHome: { variable: 'GROK_HOME', path: '/home/user/.grok-work' },
    ...overrides
  }
}

function resolver(record: AgentSessionRecord, readJournal: () => JournalLoad | null = () => null) {
  const searched: (string | null | undefined)[] = []
  return {
    searched,
    resolve: createAcpStructuredLaunchResolver(GROK, {
      store: { getRecord: () => record, pinLaunchDirectory: vi.fn() },
      readJournal,
      resolveWorkspacePath: async () => '/repo/worktree',
      resolveEnvironment: async () => ({ PATH: '/usr/bin', HOME: '/home/user' }),
      resolveLaunchEnv: () => ({ GROK_EXTRA: '1' }),
      resolveCommand: (command, options) => {
        searched.push(options?.pathEnv)
        return `/resolved/${command}`
      }
    })
  }
}

describe('ACP launch resolution', () => {
  it('uses native identity without consulting the saved transcript during launch resolution', async () => {
    const readJournal = vi.fn(() => {
      throw new Error('unreadable transcript')
    })
    const source = {
      linkId: 'source',
      origin: 'created' as const,
      mintedAtFence: 1,
      observedAt: 1,
      handle: { transport: 'acp', agent: 'grok', nativeId: 'acp-1' }
    }
    const launch = await resolver(
      grokRecord({ providerHandleChain: [source] }),
      readJournal
    ).resolve({ identity })
    expect(launch.resume).toMatchObject({ sessionId: 'acp-1', sourceLink: source })
    expect(readJournal).not.toHaveBeenCalled()
  })

  it('pins the record account home and searches the agent install dir', async () => {
    const { resolve, searched } = resolver(grokRecord())
    const launch = await resolve({ identity })
    expect(launch).toMatchObject({
      command: '/resolved/grok',
      args: ['agent', 'stdio'],
      cwd: '/repo/worktree',
      fullAccess: false,
      resume: null
    })
    expect(launch.env).toMatchObject({
      GROK_HOME: '/home/user/.grok-work',
      GROK_EXTRA: '1'
    })
    expect(searched[0]).toContain('/home/user/.grok-work/bin')
  })

  it('creates a new ACP session after clear instead of probing the old session', async () => {
    const value = grokRecord({
      providerContextBoundary: { operationId: 'clear', afterFence: 2, clearedAt: 100 },
      providerHandleChain: []
    })
    const readJournal = vi.fn(() => null)
    const launch = await resolver(value, readJournal).resolve({ identity })
    expect(launch.resume).toBeNull()
    expect(readJournal).not.toHaveBeenCalled()
  })

  it("asks the agent to approve everything only under the chat's full access", async () => {
    const start = (permissionMode: 'ask' | 'full-access') =>
      resolver(grokRecord()).resolve({ identity, spawnToken: 'token', permissionMode })
    expect((await start('full-access')).args).toContain('--always-approve')
    expect((await start('ask')).args).not.toContain('--always-approve')
  })

  it('resumes the exact chain head regardless of creation origin', async () => {
    const link = (origin: 'created' | 'resumed') => ({
      linkId: `link-${origin}`,
      origin,
      mintedAtFence: 1,
      observedAt: 1,
      handle: { transport: 'acp', agent: 'grok', nativeId: 'acp-1' }
    })
    const created = await resolver(grokRecord({ providerHandleChain: [link('created')] })).resolve({
      identity
    })
    const handle: AgentSessionProviderHandle = {
      transport: 'acp',
      agent: 'grok',
      nativeId: 'acp-1'
    }
    const key = agentSessionProviderHandleKey(handle)
    expect(created.resume).toMatchObject({ sessionId: 'acp-1', key })
    expect(created.resume?.sourceLink).toEqual(link('created'))
    const resumed = await resolver(
      grokRecord({ providerHandleChain: [link('created'), link('resumed')] })
    ).resolve({ identity })
    expect(resumed.resume).toMatchObject({ sessionId: 'acp-1', key })
    expect(resumed.resume?.sourceLink).toEqual(link('resumed'))
  })

  it('refuses a record pinned to another host or another agent', async () => {
    const remote = grokRecord()
    remote.location = { ...remote.location, executionHostId: 'ssh:box' }
    await expect(resolver(remote).resolve({ identity })).rejects.toThrow(/run on the local host/)
    await expect(resolver(agentSessionRecordFixture()).resolve({ identity })).rejects.toThrow(
      /claude session/
    )
  })
})

describe('Grok status: the structured session is the only producer', () => {
  it('strips every pane identity and hook endpoint an inherited environment carries', () => {
    const inherited = {
      PATH: '/usr/bin',
      ORCA_PANE_KEY: 'tab-1:pane-1',
      ORCA_AGENT_PANE: 'tab-1:pane-1',
      ORCA_TAB_ID: 'tab-1',
      ORCA_WORKTREE_ID: 'wt-1',
      ORCA_AGENT_LAUNCH_TOKEN: 'launch-1',
      ORCA_AGENT_HOOK_PORT: '4321',
      ORCA_AGENT_HOOK_TOKEN: 'secret',
      ORCA_AGENT_HOOK_ENDPOINT: '/tmp/endpoint'
    }
    const spec = createProviderSpawnSpec(
      {
        command: 'grok',
        args: ['agent', 'stdio'],
        env: { GROK_HOME: '/home/user/.grok' },
        envToDelete: STRUCTURED_CHILD_ENV_TO_DELETE
      },
      inherited,
      'win32'
    )
    expect(Object.keys(spec.env).filter((key) => key.startsWith('ORCA_'))).toEqual([])
    expect(spec.env).toMatchObject({ PATH: '/usr/bin', GROK_HOME: '/home/user/.grok' })
  })
})

describe('ACP launch folder of a floating chat', () => {
  const floating = (launchDirectory?: string) =>
    grokRecord({
      location: { ...grokRecord().location, workspaceId: FLOATING_TERMINAL_WORKTREE_ID },
      ...(launchDirectory ? { launchDirectory } : {})
    })
  const resolveIn = (record: AgentSessionRecord, currentSetting: string) => {
    const resolveWorkspacePath = vi.fn(async () => currentSetting)
    const pinLaunchDirectory = vi.fn()
    const resolve = createAcpStructuredLaunchResolver(GROK, {
      store: { getRecord: () => record, pinLaunchDirectory },
      readJournal: () => null,
      resolveWorkspacePath,
      resolveEnvironment: async () => ({ PATH: '/usr/bin', HOME: '/home/user' }),
      resolveCommand: (command) => `/resolved/${command}`
    })
    return { resolve, resolveWorkspacePath, pinLaunchDirectory }
  }

  it('launches in the folder the chat was pinned to after the floating setting moved', async () => {
    const pinned = mkdtempSync(join(tmpdir(), 'orca-acp-floating-'))
    try {
      const { resolve, resolveWorkspacePath } = resolveIn(floating(pinned), '/floating/moved')
      await expect(resolve({ identity })).resolves.toMatchObject({ cwd: pinned })
      expect(resolveWorkspacePath).not.toHaveBeenCalled()
    } finally {
      rmSync(pinned, { recursive: true, force: true })
    }
  })

  it('refuses with the folder-missing reason when the pinned folder is gone', async () => {
    const gone = mkdtempSync(join(tmpdir(), 'orca-acp-floating-gone-'))
    rmSync(gone, { recursive: true, force: true })
    onTestFinished(() => rmSync(gone, { recursive: true, force: true }))
    const { resolve } = resolveIn(floating(gone), '/floating/moved')
    await expect(resolve({ identity })).rejects.toMatchObject({
      name: 'AgentSessionPreSpawnError',
      reason: 'launchFolderMissing'
    })
  })

  it('pins an unpinned floating record to the folder its first launch runs in', async () => {
    const { resolve, pinLaunchDirectory } = resolveIn(floating(), '/floating/start')
    await expect(resolve({ identity })).resolves.toMatchObject({ cwd: '/floating/start' })
    expect(pinLaunchDirectory).toHaveBeenCalledExactlyOnceWith(
      identity.sessionId,
      '/floating/start'
    )
  })

  it('keeps resolving a worktree chat by its workspace, ignoring any recorded folder', async () => {
    const { resolve, resolveWorkspacePath, pinLaunchDirectory } = resolveIn(
      grokRecord({ launchDirectory: '/somewhere/else' }),
      '/repo/worktree'
    )
    await expect(resolve({ identity })).resolves.toMatchObject({ cwd: '/repo/worktree' })
    expect(resolveWorkspacePath).toHaveBeenCalledWith('workspace-1')
    expect(pinLaunchDirectory).not.toHaveBeenCalled()
  })
})
