import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import type { AgentLaunchProfileSettings } from '../../shared/tui-agent-launch-defaults'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type { AgentSessionProviderHandleLink } from '../../shared/agent-session-provider-handle'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { createCodexStructuredLaunchResolver } from './codex-structured-launch-resolution'
import { codexStructuredPermissionPolicyForSettings } from './codex-structured-permission-policy'
import { codexProviderHandle } from '../../shared/agent-session-provider-handle-encoding'

const { isWindowsProcessStartTimeAvailable } = vi.hoisted(() => ({
  isWindowsProcessStartTimeAvailable: vi.fn(() => true)
}))

vi.mock('../windows/windows-process-table', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isWindowsProcessStartTimeAvailable
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
  permissionSettings: AgentLaunchProfileSettings = { agentPermissionMode: 'ask' },
  resolveLaunchArgs?: () => string[]
) {
  return createCodexStructuredLaunchResolver({
    store: { getRecord: () => value, pinLaunchDirectory: vi.fn() },
    resolveWorkspacePath,
    resolveCommand: () => '/usr/local/bin/codex',
    resolveRollout,
    resolveLaunchArgs: resolveLaunchArgs ?? (() => value?.launchArgs ?? []),
    resolvePermissionPolicy: () => codexStructuredPermissionPolicyForSettings(permissionSettings)
  })
}

describe('codex structured launch resolution', () => {
  it.each(['start', 'resume'] as const)(
    're-reads saved Arguments after a refusal on %s',
    async (mode) => {
      let args = ['--remote', 'wss://host']
      const resolve = resolverFor(
        record({
          launchArgs: ['--enable', 'stale'],
          providerHandleChain:
            mode === 'resume'
              ? [
                  {
                    linkId: 'link-current',
                    handle: codexProviderHandle('thread-current'),
                    origin: 'created',
                    mintedAtFence: 1,
                    observedAt: 1
                  }
                ]
              : []
        }),
        undefined,
        undefined,
        { agentPermissionMode: 'ask', agentDefaultArgs: { codex: '' } },
        () => args
      )
      await expect(resolve({ identity: IDENTITY })).rejects.toThrow(/Arguments/)
      args = ['--enable', 'unified_exec']
      expect((await resolve({ identity: IDENTITY })).args).toEqual([
        '--enable',
        'unified_exec',
        'app-server'
      ])
      args = []
      expect((await resolve({ identity: IDENTITY })).args).toEqual(['app-server'])
    }
  )

  it('resumes a floating session in its pinned folder, not the current floating setting', async () => {
    const pinned = mkdtempSync(join(tmpdir(), 'orca-codex-floating-'))
    const resolveWorkspacePath = vi.fn(async () => '/floating/current-setting')
    const floating = record({
      location: { ...record().location, workspaceId: FLOATING_TERMINAL_WORKTREE_ID },
      launchDirectory: pinned
    })

    const launch = await resolverFor(floating, resolveWorkspacePath)({ identity: IDENTITY })

    expect(launch.cwd).toBe(pinned)
    expect(resolveWorkspacePath).not.toHaveBeenCalled()
  })

  it('repairs the first launch directory of an unpinned legacy floating session', async () => {
    const pinLaunchDirectory = vi.fn()
    const resolveLaunch = createCodexStructuredLaunchResolver({
      store: {
        getRecord: () =>
          record({
            location: { ...record().location, workspaceId: FLOATING_TERMINAL_WORKTREE_ID }
          }),
        pinLaunchDirectory
      },
      resolveLaunchArgs: () => [],
      resolveWorkspacePath: async () => '/floating/start-folder',
      resolveCommand: () => '/usr/local/bin/codex'
    })

    await expect(resolveLaunch({ identity: IDENTITY })).resolves.toMatchObject({
      cwd: '/floating/start-folder'
    })
    expect(pinLaunchDirectory).toHaveBeenCalledExactlyOnceWith(SESSION_ID, '/floating/start-folder')
  })

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
        resolveLaunchArgs: () => [],
        store: { getRecord: () => record(), pinLaunchDirectory: vi.fn() },
        resolveWorkspacePath: async () => String.raw`C:\workspaces\orca`,
        resolveCommand: () => command
      })

      await expect(resolveLaunch({ identity: IDENTITY })).resolves.toMatchObject({
        command,
        args: ['app-server']
      })
    })
  })

  it('resolves a Windows launch on a host that cannot read process creation times', async () => {
    isWindowsProcessStartTimeAvailable.mockReturnValue(false)
    await withPlatform('win32', async () => {
      const resolveLaunch = createCodexStructuredLaunchResolver({
        resolveLaunchArgs: () => [],
        store: { getRecord: () => record(), pinLaunchDirectory: vi.fn() },
        resolveWorkspacePath: async () => String.raw`C:\workspaces\orca`,
        resolveCommand: () => 'codex.exe'
      })

      await expect(resolveLaunch({ identity: IDENTITY })).resolves.toMatchObject({
        command: 'codex.exe',
        args: ['app-server']
      })
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

  // app-server owns the permission posture on the thread RPC, not process flags.
  it('resolves the bypass posture as app-server thread policy', async () => {
    const launch = await resolverFor(record(), undefined, undefined, {
      agentDefaultArgs: { codex: '--model gpt-5.6-sol' }
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

  it('uses saved arguments before app-server on a fresh launch', async () => {
    const launch = await resolverFor(
      record({
        launchArgs: [
          '--profile',
          'review',
          '-c',
          'model_reasoning_effort=high',
          '--model',
          'gpt-5.6-sol'
        ]
      })
    )({ identity: IDENTITY })

    expect(launch.args).toEqual([
      '-c',
      'model_reasoning_effort=high',
      '--model',
      'gpt-5.6-sol',
      'app-server'
    ])
  })

  it('pins resume to the rollout file that proved the durable thread', async () => {
    const resolveRollout = vi.fn(async () => '/home/work/.codex/sessions/rollout.jsonl')
    const launch = await resolverFor(
      record({
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resolver reads only each link's handle, so the link's other fields stay unset.
        launchArgs: ['--enable', 'unified_exec', '-c', 'model_reasoning_effort=high'],
        providerHandleChain: [
          { handle: codexProviderHandle('thread-current') }
        ] as AgentSessionRecord['providerHandleChain']
      }),
      async (id) => `/repos/${id}`,
      resolveRollout
    )({ identity: IDENTITY })

    expect(resolveRollout).toHaveBeenCalledWith('/home/work/.codex', 'thread-current')
    expect(launch.resumePath).toBe('/home/work/.codex/sessions/rollout.jsonl')
    expect(launch.args).toEqual([
      '--enable',
      'unified_exec',
      '-c',
      'model_reasoning_effort=high',
      'app-server'
    ])
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
