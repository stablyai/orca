import * as registry from '../native-chat/agent-session-wire/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
vi.mock('./structured-agent-session-runtime', () => ({
  hasPersistedStructuredAgentSessionStore: () => false
}))
import * as adoption from './structured-agent-session-create-adoption'
import { CodexStructuredSessionAdapter } from '../codex/codex-structured-session-adapter'
import { fakeCodex } from '../codex/codex-structured-session-adapter-fixture'
import { OrcaRuntimeWithRestoreStructuredAgentSessionTabsOnce } from './orca-runtime-restore-structured-agent-session-tabs-once'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import { OrcaRuntimeWithGetStructuredAgentSessionCreateSupport } from './orca-runtime-get-structured-agent-session-create-support'
vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp/profile-home'), isPackaged: false }
}))
vi.mock('./orca-runtime-get-worktree-ps', () => ({ OrcaRuntimeWithGetWorktreePs: class {} }))
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentProfileConnectionService } from '../agent-profiles/connection-service'
import {
  createClaudeProfileAdapter,
  createCodexProfileAdapter
} from '../agent-profiles/provider-adapters'
import { createClaudeStructuredLaunchResolver } from '../claude/claude-structured-launch-resolution'
import { createCodexStructuredLaunchResolver } from '../codex/codex-structured-launch-resolution'
import { foundAgentSessionRecord } from './agent-session-record-founding'
import { resolveStructuredProfileSnapshot } from './structured-agent-profile'
import { isPersistedAgentSessionRecord } from '../../shared/agent-session-record'
import type { AgentLaunchProfile, ProfileAgent } from '../../shared/agent-launch-profile'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import { pinAgentProfileTerminalCommand } from '../agent-profiles/terminal-command'

vi.mock('../claude-accounts/claude-profile-cli', () => ({
  assertClaudeProfileCli: vi.fn(async () => {})
}))
let root: string
let executable: string
let service: AgentProfileConnectionService
let profiles: AgentLaunchProfile[]
let subject: string
const release = vi.fn()
const prepare = vi.fn()
const validate = vi.fn()
const location = {
  executionHostId: 'local' as const,
  wslDistro: null,
  workspaceId: 'workspace',
  workspaceKind: 'folder' as const
}
const identity: AgentSessionJournalIdentity = {
  sessionId: 'session_1',
  providerHandle: null,
  workspaceId: location.workspaceId,
  hostId: 'local',
  agent: 'claude'
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'structured-profiles-'))
  executable = join(root, 'cli')
  await writeFile(executable, '#!/bin/sh\necho synthetic\n')
  await chmod(executable, 0o700)
  for (const id of ['one', 'two']) {
    await mkdir(join(root, id))
  }
  profiles = []
  subject = 'original'
  release.mockReset()
  validate.mockReset().mockResolvedValue(undefined)
  prepare.mockReset().mockImplementation(async (id: string) => ({
    home: join(root, id),
    envPatch: {},
    envToDelete: ['INHERITED_SECRET'],
    release
  }))
  const callbacks = {
    inspectManaged: async (id: string) => ({
      home: join(root, id),
      identity: { kind: 'verified' as const, subject: `${subject}:${id}`, displayName: id }
    }),
    prepareManaged: prepare,
    validateLaunch: validate
  }
  service = new AgentProfileConnectionService({
    host: { hostId: 'local', platform: 'linux', isWsl: false, home: root, shell: '/bin/sh' },
    adapters: {
      claude: createClaudeProfileAdapter(callbacks),
      codex: createCodexProfileAdapter(callbacks)
    },
    detectExecutable: async () => executable,
    store: {
      read: () => profiles,
      write: async (next) => {
        profiles = next
      }
    }
  })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function capture(agent: ProfileAgent, id = 'one') {
  const profile = await service.save({
    name: id,
    connection: { agent, source: { kind: 'managed', accountId: id } }
  })
  const snapshot = await resolveStructuredProfileSnapshot(service, profile.id, agent, location)
  const record = foundAgentSessionRecord(
    {
      sessionId: identity.sessionId,
      location,
      provider: agent,
      accountHome: {
        variable: agent === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME',
        path: snapshot.resolvedHome,
        agentProfile: snapshot
      }
    },
    { claimKeyId: 'key', now: 1 }
  )
  return { profile, snapshot, record }
}

it.each(['claude', 'codex'] as const)(
  '%s captures without preparation and pins independent homes after edit/unlink/runtime update',
  async (agent) => {
    const one = await capture(agent)
    const two = await capture(agent, 'two')
    expect(prepare).not.toHaveBeenCalled()
    await service.unlink(one.profile.id)
    await service.save({
      id: two.profile.id,
      name: 'renamed',
      connection: { agent, source: { kind: 'managed', accountId: 'two' } }
    })
    const oldExecutable = executable
    executable = join(root, 'updated-cli')
    await writeFile(executable, '#!/bin/sh\necho synthetic\n')
    await chmod(executable, 0o700)
    const defaultCommand = vi.fn(() => '/wrong/default')
    const defaultAuth = vi.fn(() => ({ stripAuthEnv: false }))
    for (const item of [one, two]) {
      const deps = {
        store: { getRecord: () => item.record },
        agentProfiles: service,
        resolveCommand: defaultCommand,
        resolveWorkspacePath: async () => root
      }
      const launch =
        agent === 'claude'
          ? await createClaudeStructuredLaunchResolver({
              ...deps,
              resolveAuthPolicy: defaultAuth,
              resolveInheritedEnv: async () => ({
                INHERITED_SECRET: 'secret',
                ANTHROPIC_API_KEY: 'wrong',
                PATH: '/usr/bin'
              }),
              readManagedAccountGate: () => ({
                claudeProfileMigrationAt: 10,
                activeClaudeManagedAccountId: 'different',
                activeClaudeManagedAccountIdsByRuntime: { host: null, wsl: {} },
                claudeManagedAccounts: []
              })
            })({ identity })
          : await createCodexStructuredLaunchResolver({
              ...deps,
              resolveEnvironment: async () => ({
                INHERITED_SECRET: 'secret',
                OPENAI_API_KEY: 'wrong',
                PATH: '/usr/bin'
              })
            })({ identity })
      expect(launch.env?.INHERITED_SECRET).toBeUndefined()
      expect(launch.env?.[agent === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME']).toBe(
        item.snapshot.resolvedHome
      )
      expect('command' in launch ? launch.command : launch.pathToClaudeCodeExecutable).toBe(
        executable
      )
      launch.release?.()
      expect(item.snapshot.executable).toBe(oldExecutable)
    }
    expect(defaultCommand).not.toHaveBeenCalled()
    expect(defaultAuth).not.toHaveBeenCalled()
    expect(prepare.mock.calls.map(([id]) => id)).toEqual(['one', 'two'])
    expect(release).toHaveBeenCalledTimes(2)
    if (agent === 'codex') {
      expect(validate).toHaveBeenCalledWith(
        expect.objectContaining({ resolvedHome: one.snapshot.resolvedHome }),
        expect.objectContaining({ cwd: root })
      )
    }
    const prepared = await service.prepare(one.snapshot, { mode: 'terminal', resume: true })
    expect(
      pinAgentProfileTerminalCommand(prepared, `${oldExecutable} --resume conversation`)
    ).toContain(executable)
    expect(() =>
      pinAgentProfileTerminalCommand(prepared, '/arbitrary/cli --resume conversation')
    ).toThrow()
    prepared.release()
  }
)

it.each(['claude', 'codex'] as const)(
  '%s refuses identity drift before preparation and releases when cwd resolution fails',
  async (agent) => {
    const { record } = await capture(agent)
    const deps = {
      store: { getRecord: () => record },
      agentProfiles: service,
      resolveWorkspacePath: async () => {
        throw new Error('cwd gone')
      }
    }
    const resolve =
      agent === 'claude'
        ? createClaudeStructuredLaunchResolver({
            ...deps,
            resolveAuthPolicy: () => ({ stripAuthEnv: false })
          })
        : createCodexStructuredLaunchResolver(deps)
    subject = 'changed'
    await expect(resolve({ identity })).rejects.toThrow(/identity/)
    expect(prepare).not.toHaveBeenCalled()
    subject = 'original'
    await expect(resolve({ identity })).rejects.toThrow('cwd gone')
    expect(release).toHaveBeenCalledTimes(1)
  }
)

it('rejects contradictory durable records and deep-copies the captured snapshot', async () => {
  const { record, snapshot } = await capture('claude')
  expect(isPersistedAgentSessionRecord(record)).toBe(true)
  snapshot.name = 'mutated'
  expect(record.accountHome.agentProfile?.name).toBe('one')
  for (const accountHome of [
    { ...record.accountHome, path: '/different' },
    { ...record.accountHome, variable: 'CODEX_HOME' },
    { ...record.accountHome, claudeAccountId: 'legacy' },
    {
      ...record.accountHome,
      agentProfile: {
        ...record.accountHome.agentProfile,
        identity: { kind: 'unverified', reason: 'unknown' }
      }
    }
  ]) {
    expect(isPersistedAgentSessionRecord({ ...record, accountHome })).toBe(false)
  }
  expect(isPersistedAgentSessionRecord({ ...record, provider: 'codex' })).toBe(false)
})

it('refuses external unverified identities and unsupported execution hosts before preparation', async () => {
  const profile = await service.save({
    name: 'external',
    connection: { agent: 'claude', source: { kind: 'home', value: join(root, 'one') } }
  })
  await expect(
    resolveStructuredProfileSnapshot(service, profile.id, 'claude', location)
  ).rejects.toThrow(/Unverified/)
  await expect(
    resolveStructuredProfileSnapshot(service, profile.id, 'claude', {
      ...location,
      wslDistro: 'Ubuntu'
    })
  ).rejects.toThrow(/local/)
  expect(prepare).not.toHaveBeenCalled()
})

it.each(['claude', 'codex'] as const)(
  '%s actual create intent captures common ownership without legacy preparation',
  async (agent) => {
    const { profile } = await capture(agent)
    const { runtime, prepareLegacy } = createIntentRuntime()
    const intent = await runtime.resolveStructuredAgentSessionCreateIntent({
      envelope: { sessionId: 'session_1', clientOperationId: 'operation' },
      worktree: 'workspace',
      agent,
      agentProfileId: profile.id
    })
    expect(intent.accountHome.agentProfile).toMatchObject({
      id: profile.id,
      resolvedHome: join(root, 'one')
    })
    expect(prepareLegacy).not.toHaveBeenCalled()
    expect(prepare).not.toHaveBeenCalled()
  }
)

it('Codex actual resolver and adapter honor profile release and final environment deletion', async () => {
  const { record } = await capture('codex')
  const child = fakeCodex()
  const adapter = new CodexStructuredSessionAdapter({
    resolveLaunch: createCodexStructuredLaunchResolver({
      store: { getRecord: () => record },
      agentProfiles: service,
      resolveWorkspacePath: async () => root
    }),
    openConnection: child.openConnection,
    readProcessStartTime: async () => 123
  })
  try {
    await adapter.acquire({ identity, fence: 1, spawnToken: 'spawn-profile' })
    expect(child.connections[0].launch.env?.CODEX_HOME).toBe(record.accountHome.path)
    expect(child.connections[0].launch.envToDelete).toContain('OPENAI_API_KEY')
    expect(child.connections[0].launch.command).toBe(executable)
    expect(release).toHaveBeenCalledTimes(1)
  } finally {
    await adapter.closeAll()
  }
})

function createIntentRuntime() {
  const prepareLegacy = vi.fn(() => {
    throw new Error('global preparation must not run')
  })
  const runtime = new OrcaRuntimeWithGetStructuredAgentSessionCreateSupport(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this create-intent fixture supplies the only store method read on the explicitly stubbed local route.
    {
      getSettings: () => ({
        agentDefaultEnv: {},
        claudeManagedAccounts: [],
        codexManagedAccounts: []
      })
    } as never,
    undefined,
    {
      agentProfiles: service,
      prepareCodexStructuredLaunch: prepareLegacy,
      prepareClaudeAuth: prepareLegacy
    }
  )
  vi.spyOn(runtime, 'getStructuredAgentSessionCreateSupport').mockResolvedValue({ supported: true })
  Object.assign(runtime, {
    agentProfiles: service,
    prepareClaudeAuth: prepareLegacy,
    prepareCodexStructuredLaunchFn: prepareLegacy,
    requireStore: () => ({
      getSettings: () => ({
        agentDefaultEnv: {},
        claudeManagedAccounts: [],
        codexManagedAccounts: []
      })
    }),
    resolveStructuredAgentSessionLocation: async () => location,
    resolveRuntimeFileTarget: async () => ({ worktree: { path: root } })
  })
  return { runtime, prepareLegacy }
}

it.each(['claude', 'codex'] as const)(
  '%s refuses adoption discovered under another account home',
  async (agent) => {
    const { profile } = await capture(agent)
    const discover = vi
      .spyOn(adoption, 'resolveStructuredAgentSessionAdoptionForCreate')
      .mockResolvedValue({
        accountHomePath: join(root, 'two'),
        transcriptPath: join(root, 'other.jsonl')
      })
    try {
      await expect(
        createIntentRuntime().runtime.resolveStructuredAgentSessionCreateIntent({
          envelope: { sessionId: 'session_1', clientOperationId: 'operation' },
          worktree: 'workspace',
          agent,
          agentProfileId: profile.id,
          resumeFrom: { providerSessionId: 'conversation' }
        })
      ).rejects.toThrow(/another.*account/)
      expect(prepare).not.toHaveBeenCalled()
    } finally {
      discover.mockRestore()
    }
  }
)

it('releases Codex preparation when effective launch authority refuses', async () => {
  const { record } = await capture('codex')
  validate.mockRejectedValue(new Error('effective authority unknown'))
  const resolve = createCodexStructuredLaunchResolver({
    store: { getRecord: () => record },
    agentProfiles: service,
    resolveWorkspacePath: async () => root
  })
  await expect(resolve({ identity })).rejects.toThrow()
  expect(release).toHaveBeenCalledTimes(1)
})

it.each(['claude', 'codex'] as const)(
  '%s committed create replay survives launcher unlink without resolution',
  async (agent) => {
    const { profile, record } = await capture(agent)
    await service.unlink(profile.id)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: committed replay only reads these durable store methods.
    const host = {
      deps: {
        store: {
          getRecord: () => record,
          listOperationRows: () => [
            {
              callerKey: 'caller',
              operationId: 'operation',
              outcome: { status: 'succeeded', sessionId: record.sessionId }
            }
          ]
        }
      }
    } as unknown as StructuredAgentSessionHost
    const installed = vi.spyOn(registry, 'getStructuredAgentSessionHost').mockReturnValue(host)
    const resolve = vi.spyOn(service, 'resolveSnapshotById')
    try {
      const intent = await createIntentRuntime().runtime.resolveStructuredAgentSessionCreateIntent({
        envelope: { sessionId: record.sessionId, clientOperationId: 'operation' },
        worktree: 'workspace',
        agent,
        agentProfileId: profile.id,
        callerKey: 'caller'
      })
      expect(intent.accountHome).toEqual(record.accountHome)
      expect(resolve).not.toHaveBeenCalled()
      expect(prepare).not.toHaveBeenCalled()
    } finally {
      installed.mockRestore()
      resolve.mockRestore()
    }
  }
)

it.each(['claude', 'codex'] as const)(
  '%s unknown profile create refuses without consulting the default account',
  async (agent) => {
    const { runtime, prepareLegacy } = createIntentRuntime()
    await expect(
      runtime.resolveStructuredAgentSessionCreateIntent({
        envelope: { sessionId: 'unknown_session', clientOperationId: 'operation' },
        worktree: 'workspace',
        agent,
        agentProfileId: 'missing'
      })
    ).rejects.toThrow(/no longer exists/)
    expect(prepareLegacy).not.toHaveBeenCalled()
    expect(prepare).not.toHaveBeenCalled()
  }
)

it.each(['claude', 'codex'] as const)(
  '%s restored tab uses the captured name after unlink',
  async (agent) => {
    const { profile, record } = await capture(agent)
    await service.unlink(profile.id)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: tab projection reads only the durable record from this host fixture.
    const host = {
      deps: { store: { getRecord: () => record } }
    } as unknown as StructuredAgentSessionHost
    const installed = vi.spyOn(registry, 'getStructuredAgentSessionHost').mockReturnValue(host)
    const save = vi.fn((_workspace: string, snapshot: RuntimeMobileSessionTabsSnapshot) => snapshot)
    try {
      const runtime = Object.assign(new OrcaRuntimeWithRestoreStructuredAgentSessionTabsOnce(), {
        mobileSessionTabsByWorktree: new Map(),
        storeMobileSessionSnapshot: save,
        emitMobileSessionTabsSnapshot: vi.fn()
      })
      runtime.projectStructuredAgentSessionTab({
        workspaceId: 'workspace',
        sessionId: record.sessionId,
        agent,
        activate: false
      })
      expect(save.mock.calls[0][1].tabs[0].title).toBe(record.accountHome.agentProfile?.name)
      expect(save.mock.calls[0][1].tabs[0].title).toBe('one')
    } finally {
      installed.mockRestore()
    }
  }
)
