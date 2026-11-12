import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginCapabilityKind } from '../../../../shared/plugins/capabilities/plugin-capabilities'
import { callPluginHost, pluginHostTestServices } from './__mocks__/plugin-host-services-fixture'
import { PLUGIN_HISTORY_TTL_MS } from './plugin-agent-history'
import type { PluginRuntimeRpc } from './plugin-host-runtime-call'
import type { PluginHostServices } from './plugin-host-method-bindings'

const WORKTREES = {
  worktrees: [
    // A project's own folder, with a worktree nested inside it.
    { id: 'r1::/src/r1', repoId: 'r1', displayName: 'r1', path: '/src/r1', hostId: 'local' },
    {
      id: 'r1::/src/r1/.worktrees/seal',
      repoId: 'r1',
      displayName: 'seal',
      path: '/src/r1/.worktrees/seal',
      hostId: 'local',
      identity: { key: 'wt2:local:seal' }
    },
    // The same path on an SSH machine is another computer's folder.
    { id: 'r2::/src/r1', repoId: 'r2', displayName: 'remote', path: '/src/r1', hostId: 'ssh:box' }
  ]
}
const FOLDERS = {
  folderWorkspaces: [{ id: 'notes', name: 'Notes', folderPath: '/notes', executionHostId: null }]
}

function vaultRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'row',
    executionHostId: 'local',
    agent: 'claude',
    sessionId: 's-1',
    title: 'Fix the login\n  page',
    cwd: '/src/r1/.worktrees/seal/app',
    branch: 'refs/heads/seal',
    model: 'opus',
    filePath: '/home/me/.claude/projects/x/s-1.jsonl',
    codexHome: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    modifiedAt: '2026-01-02T00:00:00.000Z',
    messageCount: 12,
    totalTokens: 3400,
    previewMessages: [{ role: 'user', text: 'secret prompt', timestamp: null }],
    firstUserPrompt: 'secret prompt',
    lastUserPrompt: 'another secret',
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: 'claude --resume s-1',
    subagent: null,
    ...overrides
  }
}

function runtime(answers: Record<string, unknown> = {}) {
  const all: Record<string, unknown> = {
    'worktree.list': WORKTREES,
    'repo.list': {
      repos: [
        { id: 'r1', kind: 'git' },
        { id: 'r2', connectionId: 'box' }
      ]
    },
    'folderWorkspace.list': FOLDERS,
    'aiVault.listSessions': {
      sessions: [vaultRow()],
      issues: [],
      scannedAt: 'x',
      fingerprint: 'f1'
    },
    ...answers
  }
  return vi.fn<PluginRuntimeRpc>(async (method, params) => {
    const answer = all[method]
    if (answer instanceof Error) {
      throw answer
    }
    return typeof answer === 'function' ? answer(params) : answer
  })
}

const listSessions = (
  rpc: PluginRuntimeRpc,
  params: unknown = {},
  overrides: Partial<PluginHostServices> = {},
  granted: PluginCapabilityKind[] = ['history:read']
) =>
  callPluginHost({
    method: 'agent.listSessions',
    params,
    granted,
    services: pluginHostTestServices(rpc, overrides)
  })

const vaultCalls = (rpc: ReturnType<typeof runtime>) =>
  rpc.mock.calls.filter(([method]) => method === 'aiVault.listSessions').map(([, params]) => params)

afterEach(() => {
  vi.useRealTimers()
})

describe('agent.listSessions', () => {
  it('ranks a symlinked workspace by its resolved folder', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-history-')))
    try {
      const deep = join(root, 'project', 'deep', 'worktree')
      mkdirSync(deep, { recursive: true })
      const link = join(root, 'l')
      symlinkSync(deep, link, process.platform === 'win32' ? 'junction' : 'dir')
      const project = join(root, 'project')
      const rpc = runtime({
        'worktree.list': {
          worktrees: [
            {
              id: `r1::${project}`,
              repoId: 'r1',
              displayName: 'p',
              path: project,
              hostId: 'local'
            },
            { id: `r1::${link}`, repoId: 'r1', displayName: 'l', path: link, hostId: 'local' }
          ]
        },
        'folderWorkspace.list': { folderWorkspaces: [] },
        'aiVault.listSessions': { sessions: [vaultRow({ cwd: deep })], issues: [], scannedAt: 'x' }
      })
      const outcome = await listSessions(rpc)
      expect(outcome.ok && outcome.value).toMatchObject({
        sessions: [{ workspaceId: `r1::${link}` }]
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('shares one read among calls, then revalidates it by fingerprint', async () => {
    vi.useFakeTimers()
    const rpc = runtime({
      'aiVault.listSessions': (params: { afterFingerprint?: string }) =>
        params.afterFingerprint === 'f1'
          ? { sessions: [], issues: [], scannedAt: 'y', fingerprint: 'f1', unchanged: true }
          : { sessions: [vaultRow()], issues: [], scannedAt: 'x', fingerprint: 'f1' }
    })
    const [first, second] = await Promise.all([listSessions(rpc), listSessions(rpc)])
    expect(second).toEqual(first)
    expect(vaultCalls(rpc)).toHaveLength(1)
    vi.advanceTimersByTime(PLUGIN_HISTORY_TTL_MS + 1)
    // Unchanged history keeps the rows already read.
    expect(await listSessions(rpc)).toEqual(first)
    expect(vaultCalls(rpc)).toEqual([
      { limit: 200, afterFingerprint: null },
      { limit: 200, afterFingerprint: 'f1' }
    ])
  })
})
