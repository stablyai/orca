import { describe, expect, it } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { AgentSessionRecordStore } from '../runtime/agent-session-record-store'
import { createCodexStructuredLaunchResolver } from './codex-structured-launch-resolution'

const SESSION_ID = 'session-1'
const IDENTITY = { sessionId: SESSION_ID } as Parameters<
  ReturnType<typeof createCodexStructuredLaunchResolver>
>[0]['identity']

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
  localStructuredWriteOnly = false
) {
  return createCodexStructuredLaunchResolver({
    store: { getRecord: () => value } as unknown as AgentSessionRecordStore,
    resolveWorkspacePath,
    resolveCommand: () => '/usr/local/bin/codex',
    canonicalizePath: async (path) => path,
    localStructuredWriteOnly,
    ...(localStructuredWriteOnly
      ? {
          resolveStructuredWriteSourceHome: async () => '/home/work/.codex',
          prepareStructuredWriteHome: async (sessionId: string) => `/isolated-codex/${sessionId}`
        }
      : {})
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
      resumeThreadId: null
    })
  })

  it('resumes the last thread this session actually proved, not one a caller names', async () => {
    const launch = await resolverFor(
      record({
        providerHandleChain: [
          { handle: { provider: 'codex', threadId: 'thread-old' } },
          { handle: { provider: 'codex', threadId: 'thread-current' } }
        ] as AgentSessionRecord['providerHandleChain']
      })
    )({ identity: IDENTITY })

    expect(launch.resumeThreadId).toBe('thread-current')
  })

  it('starts the opt-in writer with every other effect surface disabled', async () => {
    const launch = await resolverFor(record(), undefined, true)({ identity: IDENTITY })

    expect(launch.effectIsolation).toBe('local-structured-write')
    expect(launch.codexHome).toBe('/isolated-codex/session-1')
    expect(launch.isolatedHomePath).toBe('/isolated-codex/session-1')
    expect(launch.args.at(-1)).toBe('app-server')
    expect(launch.args).not.toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(launch.args).not.toContain('code_mode_host')
    for (const feature of [
      'apps',
      'plugins',
      'remote_plugin',
      'computer_use',
      'browser_use',
      'in_app_browser',
      'image_generation',
      'artifact',
      'multi_agent',
      'code_mode',
      'shell_tool',
      'unified_exec',
      'hooks',
      'tool_suggest',
      'skill_search',
      'view_image',
      'standalone_web_search'
    ]) {
      const index = launch.args.indexOf(feature)
      expect(index).toBeGreaterThan(0)
      expect(launch.args[index - 1]).toBe('--disable')
    }
  })

  it('fails closed when writer isolation has no credential-home provider', async () => {
    const resolver = createCodexStructuredLaunchResolver({
      store: { getRecord: () => record() } as unknown as AgentSessionRecordStore,
      resolveWorkspacePath: async () => '/repos/workspace-1',
      resolveCommand: () => '/usr/local/bin/codex',
      localStructuredWriteOnly: true,
      resolveStructuredWriteSourceHome: async () => '/home/work/.codex'
    })

    await expect(resolver({ identity: IDENTITY })).rejects.toThrow('isolated Codex home provider')
  })

  it('fails closed instead of resuming a thread with unknown prior effect isolation', async () => {
    const existing = record({
      providerHandleChain: [
        { handle: { provider: 'codex', threadId: 'thread-existing' } }
      ] as AgentSessionRecord['providerHandleChain']
    })

    await expect(resolverFor(existing, undefined, true)({ identity: IDENTITY })).rejects.toThrow(
      'cannot resume a thread'
    )
  })

  it('rejects a client-recorded credential path that differs from the host registry', async () => {
    let prepared = false
    const resolver = createCodexStructuredLaunchResolver({
      store: {
        getRecord: () =>
          record({ accountHome: { variable: 'CODEX_HOME', path: '/client/selected/home' } })
      } as unknown as AgentSessionRecordStore,
      resolveWorkspacePath: async () => '/repos/workspace-1',
      resolveCommand: () => '/usr/local/bin/codex',
      canonicalizePath: async (path) => path,
      localStructuredWriteOnly: true,
      resolveStructuredWriteSourceHome: async () => '/host/registry/home',
      prepareStructuredWriteHome: async () => {
        prepared = true
        return '/must-not-exist'
      }
    })

    await expect(resolver({ identity: IDENTITY })).rejects.toThrow('host-owned credential source')
    expect(prepared).toBe(false)
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

  it('does not materialise credentials when the selected workspace is stale', async () => {
    let prepared = false
    const resolver = createCodexStructuredLaunchResolver({
      store: { getRecord: () => record() } as unknown as AgentSessionRecordStore,
      resolveWorkspacePath: async () => {
        throw new Error('workspace is stale')
      },
      resolveCommand: () => '/usr/local/bin/codex',
      canonicalizePath: async (path) => path,
      localStructuredWriteOnly: true,
      resolveStructuredWriteSourceHome: async () => '/home/work/.codex',
      prepareStructuredWriteHome: async () => {
        prepared = true
        return '/must-not-exist'
      }
    })

    await expect(resolver({ identity: IDENTITY })).rejects.toThrow('workspace is stale')
    expect(prepared).toBe(false)
  })
})
