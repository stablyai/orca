import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type { AgentSessionProviderHandleLink } from '../../shared/agent-session-provider-handle'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { AgentSessionRecordStore } from '../runtime/agent-session-record-store'
import {
  createCodexStructuredLaunchResolver,
  openCodexStructuredChild
} from './codex-structured-launch-resolution'
import { codexStructuredPermissionPolicyForSettings } from './codex-structured-permission-policy'
import { codexProviderHandle } from '../../shared/agent-session-provider-handle-encoding'

// The host's own install directories are this machine's; each case names the only places it has.
vi.mock('../../shared/system-cli-install-dirs', () => ({
  getSystemCliInstallDirectories: () => []
}))

const SESSION_ID = 'session-1'
const IDENTITY = { sessionId: SESSION_ID } as Parameters<
  ReturnType<typeof createCodexStructuredLaunchResolver>
>[0]['identity']

async function withPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T> {
  const original = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  try {
    return await run()
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: original })
  }
}

function record(overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord {
  return {
    sessionId: SESSION_ID,
    provider: 'codex',
    location: {
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'git-worktree'
    },
    accountHome: { variable: 'CODEX_HOME', path: '/home/work/.codex' },
    providerHandleChain: [],
    ...overrides
  } as AgentSessionRecord
}

function resolverFor(
  value: AgentSessionRecord | null,
  resolveWorkspacePath: (workspaceId: string) => Promise<string> = async (id) => `/repos/${id}`,
  resolveRollout: () => Promise<string | null> = async () => null,
  agentDefaultArgs: Record<string, string> = { codex: '' }
) {
  return createCodexStructuredLaunchResolver({
    store: { getRecord: () => value } as unknown as AgentSessionRecordStore,
    resolveWorkspacePath,
    resolveCommand: () => '/usr/local/bin/codex',
    resolveRollout,
    isWindowsProcessStartTimeAvailable: () => true,
    resolvePermissionPolicy: () => codexStructuredPermissionPolicyForSettings({ agentDefaultArgs })
  })
}

describe('codex structured launch resolution', () => {
  it('launches the app server in the workspace and account home the record pinned', async () => {
    const launch = await resolverFor(record())({ identity: IDENTITY })

    expect(launch).toEqual({
      command: '/usr/local/bin/codex',
      args: ['app-server'],
      cwd: '/repos/workspace-1',
      codexHome: '/home/work/.codex',
      resumeThreadId: null,
      // Every launch now carries a posture; neither one is left for config.toml to decide.
      permissionPolicy: { approvalPolicy: 'on-request', sandbox: 'workspace-write' }
    })
  })

  it('passes a Windows .cmd path containing cmd syntax directly to the safe spawn layer', async () => {
    const command = String.raw`C:\Users\r&d\npm-prefix\codex.cmd`

    await withPlatform('win32', async () => {
      const resolveLaunch = createCodexStructuredLaunchResolver({
        store: { getRecord: () => record() } as unknown as AgentSessionRecordStore,
        resolveWorkspacePath: async () => String.raw`C:\workspaces\orca`,
        resolveCommand: () => command,
        isWindowsProcessStartTimeAvailable: () => true
      })

      await expect(resolveLaunch({ identity: IDENTITY })).resolves.toMatchObject({
        command,
        args: ['app-server']
      })
    })
  })

  it('fails closed before resolving a Windows launch without creation-time proof', async () => {
    await withPlatform('win32', async () => {
      const resolveWorkspacePath = vi.fn(async () => String.raw`C:\workspaces\orca`)
      const resolveLaunch = createCodexStructuredLaunchResolver({
        store: { getRecord: () => record() } as unknown as AgentSessionRecordStore,
        resolveWorkspacePath,
        isWindowsProcessStartTimeAvailable: () => false
      })

      await expect(resolveLaunch({ identity: IDENTITY })).rejects.toThrow(
        'Windows process creation-time proof'
      )
      expect(resolveWorkspacePath).not.toHaveBeenCalled()
    })
  })

  it('resumes the last thread this session actually proved, not one a caller names', async () => {
    const launch = await resolverFor(
      record({
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resolver reads only each link's handle, so the link's other fields stay unset.
        providerHandleChain: [
          { handle: codexProviderHandle('thread-old') },
          { handle: codexProviderHandle('thread-current') }
        ] as AgentSessionRecord['providerHandleChain']
      })
    )({ identity: IDENTITY })

    expect(launch.resumeThreadId).toBe('thread-current')
  })

  it('lets only a thread this session created be superseded when Codex never saved it', async () => {
    const link = (
      origin: AgentSessionProviderHandleLink['origin'],
      mintedAtFence: number
    ): AgentSessionProviderHandleLink => ({
      linkId: `link-${mintedAtFence}`,
      handle: codexProviderHandle('t'),
      origin,
      mintedAtFence,
      observedAt: 1
    })
    const chainFor = (origin: 'created' | 'resumed' | 'adopted') =>
      origin === 'resumed' ? [link('created', 1), link('resumed', 2)] : [link(origin, 1)]

    const created = await resolverFor(record({ providerHandleChain: chainFor('created') }))({
      identity: IDENTITY
    })
    expect(created).toMatchObject({ resumeThreadId: 't', supersedeIfUnsaved: true })
    for (const origin of ['resumed', 'adopted'] as const) {
      const launch = await resolverFor(record({ providerHandleChain: chainFor(origin) }))({
        identity: IDENTITY
      })
      expect(launch.resumeThreadId).toBe('t')
      expect(launch).not.toHaveProperty('supersedeIfUnsaved')
    }
    const fresh = await resolverFor(record())({ identity: IDENTITY })
    expect(fresh).not.toHaveProperty('supersedeIfUnsaved')
  })

  // Agent Permissions is the only thing derived from the arguments field. app-server owns it on
  // the thread RPC rather than through the interactive CLI's process flags.
  it('resolves the bypass posture as app-server thread policy', async () => {
    const launch = await resolverFor(record(), undefined, undefined, {
      codex: '--dangerously-bypass-approvals-and-sandbox --model gpt-5.6-sol'
    })({ identity: IDENTITY })

    expect(launch.args).toEqual(['app-server'])
    expect(launch.permissionPolicy).toEqual({
      approvalPolicy: 'never',
      sandbox: 'danger-full-access'
    })
  })

  it('bypasses approvals for a profile that never opened Agent settings', async () => {
    const launch = await resolverFor(record(), undefined, undefined, {})({ identity: IDENTITY })

    expect(launch.args).toEqual(['app-server'])
    expect(launch.permissionPolicy).toEqual({
      approvalPolicy: 'never',
      sandbox: 'danger-full-access'
    })
  })

  // Stated, not omitted: app-server resolves an absent field through the mirrored config.toml,
  // so a Manual session on a home carrying `approval_policy = "never"` never prompted at all.
  it('states the approval posture under Manual', async () => {
    const launch = await resolverFor(record())({ identity: IDENTITY })

    expect(launch.args).toEqual(['app-server'])
    expect(launch.permissionPolicy).toEqual({
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write'
    })
  })

  // A thread opened on the configured default and then given a turn on the saved model reads to
  // Codex as a model switch, and it injects the saved model's whole prompt a second time.
  it('opens the thread on the model the record saved', async () => {
    const launch = await resolverFor(
      record({ options: { model: 'gpt-chosen', effort: 'high', fastMode: 'false' } })
    )({ identity: IDENTITY })

    expect(launch.model).toBe('gpt-chosen')
  })

  // The configured CLI arguments are a terminal concern: a durable record written before they
  // stopped being read must not smuggle one back into app-server's argv.
  it("ignores the record's durable launch arguments", async () => {
    const launch = await resolverFor(
      record({ launchArgs: ['--profile', 'review', '-c', 'model_reasoning_effort=high'] })
    )({ identity: IDENTITY })

    expect(launch.args).toEqual(['app-server'])
  })

  it('pins resume to the rollout file that proved the durable thread', async () => {
    const resolveRollout = vi.fn(async () => '/home/work/.codex/sessions/rollout.jsonl')
    const launch = await resolverFor(
      record({
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resolver reads only each link's handle, so the link's other fields stay unset.
        providerHandleChain: [
          { handle: codexProviderHandle('thread-current') }
        ] as AgentSessionRecord['providerHandleChain']
      }),
      async (id) => `/repos/${id}`,
      resolveRollout
    )({ identity: IDENTITY })

    expect(resolveRollout).toHaveBeenCalledWith('/home/work/.codex', 'thread-current')
    expect(launch.resumePath).toBe('/home/work/.codex/sessions/rollout.jsonl')
  })

  it('refuses a session pinned to another host rather than starting a second writer here', async () => {
    await expect(
      resolverFor(
        record({
          location: { ...record().location, executionHostId: 'ssh:build-box' }
        } as Partial<AgentSessionRecord>)
      )({ identity: IDENTITY })
    ).rejects.toThrow(/local host/)
  })

  it('refuses a WSL session, which is a separate filesystem and process namespace', async () => {
    await expect(
      resolverFor(record({ location: { ...record().location, wslDistro: 'Ubuntu' } }))({
        identity: IDENTITY
      })
    ).rejects.toThrow(/local host/)
  })

  it('refuses a record this adapter does not speak for', async () => {
    await expect(
      resolverFor(record({ provider: 'claude' } as Partial<AgentSessionRecord>))({
        identity: IDENTITY
      })
    ).rejects.toThrow(/is a claude session/)
    await expect(
      resolverFor(
        record({ accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/.claude' } })
      )({
        identity: IDENTITY
      })
    ).rejects.toThrow(/CODEX_HOME/)
  })

  it('refuses to launch for a session the store has no record of', async () => {
    await expect(resolverFor(null)({ identity: IDENTITY })).rejects.toThrow(/no durable/)
  })

  it('surfaces a workspace that no longer resolves instead of falling back to a default cwd', async () => {
    await expect(
      resolverFor(record(), async () => {
        throw new Error('workspace-1 is gone')
      })({ identity: IDENTITY })
    ).rejects.toThrow('workspace-1 is gone')
  })
})

describe('a Codex CLI the host cannot find', () => {
  function executable(dir: string, name: string): void {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, name), '')
    chmodSync(join(dir, name), 0o755)
  }

  /** The real child with the resolver's bare name; `env` is what the spawn itself gets. Its spawn
   *  is stubbed, so reaching it means the check let the start through. */
  function open(env: Record<string, string>) {
    const spawned = new Error('spawned')
    return {
      spawned,
      opened: openCodexStructuredChild({ command: 'codex', args: ['app-server'], env }, {}, () => {
        throw spawned
      })
    }
  }

  it.skipIf(process.platform === 'win32')(
    'is refused as missing before any spawn when neither PATH nor an install directory has it',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'orca-codex-missing-'))

      await expect(
        open({ PATH: join(root, 'bin'), HOME: join(root, 'home') }).opened
      ).rejects.toMatchObject({
        name: 'AgentSessionPreSpawnError',
        reason: 'providerMissing',
        needsUser: true
      })
    }
  )

  it.skipIf(process.platform === 'win32')(
    "spawns one only the spawn's PATH or a version manager has",
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'orca-codex-found-'))
      executable(join(root, 'shell-bin'), 'codex')
      executable(join(root, 'home', '.volta', 'bin'), 'codex')

      for (const env of [
        { PATH: join(root, 'shell-bin'), HOME: join(root, 'empty-home') },
        { PATH: join(root, 'bin'), HOME: join(root, 'home') }
      ]) {
        const { spawned, opened } = open(env)
        await expect(opened).rejects.toBe(spawned)
      }
    }
  )

  // The launch is only the record's: whether the CLI is there is the spawn's to find, so a host
  // that opens its own connection never reads this machine's PATH.
  it('resolves the launch whether or not this machine has codex', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-codex-launch-'))
    await expect(
      createCodexStructuredLaunchResolver({
        store: { getRecord: () => record() } as unknown as AgentSessionRecordStore,
        resolveWorkspacePath: async (id) => `/repos/${id}`,
        resolveCommand: () => 'codex',
        resolveEnvironment: async () => ({ PATH: join(root, 'bin'), HOME: join(root, 'home') }),
        isWindowsProcessStartTimeAvailable: () => true
      })({ identity: IDENTITY })
    ).resolves.toMatchObject({ command: 'codex' })
  })
})
