import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  validateWorkerAgentForRepo,
  validateWorkerAgentForWorktree
} from './worker-agent-availability'
import type { WorkerAgentSettings } from './worker-agent-availability'
import type { TerminalWorkspaceLaunchScope } from '../../terminal-authority/structured-sessions/runtime-legacy-worker-terminal-recovery-types'
import type { Repo } from '../../../../../shared/repo-types'

const { detectInstalled, detectWsl } = vi.hoisted(() => ({
  detectInstalled: vi.fn<() => Promise<string[]>>(),
  detectWsl: vi.fn<() => Promise<Set<string>>>()
}))
vi.mock('../../../../preflight/installed-agent-detection', () => ({
  detectInstalledAgentsWithShellPathHydration: detectInstalled
}))
vi.mock('../../../../ipc/preflight-wsl-agent-detection', () => ({
  detectWslCommandsOnPath: detectWsl
}))

const roots: string[] = []
const folder: TerminalWorkspaceLaunchScope = {
  id: 'folder:worker',
  path: '/workspace',
  connectionId: null,
  repo: null,
  folderWorkspace: {
    id: 'worker',
    projectGroupId: 'group',
    name: 'Worker folder',
    folderPath: '/workspace',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0
  }
}
const uncFolder = { ...folder, path: String.raw`\\wsl.localhost\Ubuntu\home\u\workspace` }
function store(settings: Partial<WorkerAgentSettings> = {}) {
  return {
    getSettings: () => ({
      nestWorkspaces: false,
      workspaceDir: '',
      agentCmdOverrides: {},
      ...settings
    })
  }
}
function runtime(scope = folder) {
  return {
    validateOrchestrationAgentLauncher: () => {},
    resolveTerminalWorkspaceLaunchScope: async () => scope
  }
}
function executable() {
  const root = mkdtempSync(join(tmpdir(), 'orca-worker-admission-'))
  roots.push(root)
  const command = join(root, process.platform === 'win32' ? 'my agent.cmd' : 'my agent')
  writeFileSync(command, '#!/bin/sh\nexit 0\n')
  chmodSync(command, 0o755)
  return command
}
beforeEach(() => {
  detectInstalled.mockResolvedValue([])
  detectWsl.mockResolvedValue(new Set())
})
afterEach(() => {
  vi.clearAllMocks()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('worker launcher admission on canonical workspace scopes', () => {
  it('accepts an installed launcher in a genuine repo-less folder', async () => {
    detectInstalled.mockResolvedValue(['codex'])
    await expect(
      validateWorkerAgentForWorktree(runtime(), store(), 'codex', folder.id)
    ).resolves.toBeUndefined()
  })
  it('rejects an absent launcher without requiring a repository registration', async () => {
    await expect(
      validateWorkerAgentForWorktree(runtime(), store(), 'codex', folder.id)
    ).rejects.toMatchObject({ code: 'agent_not_available' })
  })
  it('refuses an unserved folder host rather than using this machine', async () => {
    detectInstalled.mockResolvedValue(['codex'])
    await expect(
      validateWorkerAgentForWorktree(
        runtime({ ...folder, connectionId: 'remote-folder' }),
        store(),
        'codex',
        folder.id
      )
    ).rejects.toMatchObject({ code: 'ssh_host_not_served', connectionId: 'remote-folder' })
  })
  it('refuses a repository identified only by SSH execution-host ownership', async () => {
    const target = {
      validateOrchestrationAgentLauncher: () => {},
      showRepo: async (): Promise<Repo> => ({
        id: 'repo',
        path: '/repo',
        displayName: 'Repo',
        badgeColor: '#000',
        addedAt: 0,
        executionHostId: 'ssh:remote-repo'
      })
    }
    await expect(
      validateWorkerAgentForRepo(target, store(), 'codex', 'id:repo')
    ).rejects.toMatchObject({ code: 'ssh_host_not_served', connectionId: 'remote-repo' })
  })
  it('accepts the configured native executable outside the default PATH', async () => {
    const command = executable()
    const settings = store({ agentCmdOverrides: { codex: `"${command}" --profile work` } })
    await expect(
      validateWorkerAgentForWorktree(runtime(), settings, 'codex', folder.id)
    ).resolves.toBeUndefined()
  })
  it('resolves a relative terminal override against the actual folder cwd', async () => {
    const command = executable()
    const cwd = join(command, '..')
    const settings = store({ agentCmdOverrides: { codex: '"./my agent" --profile work' } })
    await expect(
      validateWorkerAgentForWorktree(
        runtime({ ...folder, path: cwd }),
        settings,
        'codex',
        folder.id
      )
    ).resolves.toBeUndefined()
  })
  it('does not substitute an installed default for a missing configured native command', async () => {
    detectInstalled.mockResolvedValue(['codex'])
    const settings = store({
      agentCmdOverrides: { codex: '/missing/orca-admission-codex --profile work' }
    })
    await expect(
      validateWorkerAgentForWorktree(runtime(), settings, 'codex', folder.id)
    ).rejects.toMatchObject({ code: 'agent_not_available' })
  })
  it('accepts a quoted structured program with literal prefix arguments', async () => {
    const command = executable()
    const settings = store({ agentCmdOverrides: { codex: `"${command}" --profile work` } })
    await expect(
      validateWorkerAgentForWorktree(runtime(), settings, 'codex', folder.id, 'structured')
    ).resolves.toBeUndefined()
  })
  it('refuses shell operators in a structured Command before launch', async () => {
    detectInstalled.mockResolvedValue(['codex'])
    const settings = store({ agentCmdOverrides: { codex: 'wrapper && codex' } })
    await expect(
      validateWorkerAgentForWorktree(runtime(), settings, 'codex', folder.id, 'structured')
    ).rejects.toMatchObject({ code: 'agent_not_available' })
  })
  it('refuses a missing structured program despite an installed default', async () => {
    detectInstalled.mockResolvedValue(['codex'])
    const settings = store({
      agentCmdOverrides: { codex: '/missing/orca-admission-codex --profile work' }
    })
    await expect(
      validateWorkerAgentForWorktree(runtime(), settings, 'codex', folder.id, 'structured')
    ).rejects.toMatchObject({ code: 'agent_not_available' })
  })
  it('accepts the requested custom command in a repo-less UNC guest', async () => {
    detectWsl.mockResolvedValue(new Set(['~/bin/worker-codex']))
    const settings = store({ agentCmdOverrides: { codex: '~/bin/worker-codex --profile work' } })
    await expect(
      validateWorkerAgentForWorktree(runtime(uncFolder), settings, 'codex', folder.id)
    ).resolves.toBeUndefined()
  })
  it('does not substitute the guest default for a missing guest override', async () => {
    detectInstalled.mockResolvedValue(['codex'])
    const settings = store({ agentCmdOverrides: { codex: '~/bin/worker-codex' } })
    await expect(
      validateWorkerAgentForWorktree(runtime(uncFolder), settings, 'codex', folder.id)
    ).rejects.toMatchObject({ code: 'agent_not_available' })
  })
  it('preserves an unavailable guest override failure instead of reporting missing CLI', async () => {
    detectInstalled.mockResolvedValue(['codex'])
    detectWsl.mockRejectedValue(
      Object.assign(new Error('Guest unavailable'), { code: 'remote_runtime_unavailable' })
    )
    const settings = store({ agentCmdOverrides: { codex: '~/bin/worker-codex' } })
    await expect(
      validateWorkerAgentForWorktree(runtime(uncFolder), settings, 'codex', folder.id)
    ).rejects.toMatchObject({ code: 'remote_runtime_unavailable' })
  })
  it('preserves failed execution-host inventory as unavailable', async () => {
    detectInstalled.mockRejectedValue(
      Object.assign(new Error('Guest unavailable'), { code: 'remote_runtime_unavailable' })
    )
    await expect(
      validateWorkerAgentForWorktree(runtime(uncFolder), store(), 'codex', folder.id)
    ).rejects.toMatchObject({ code: 'remote_runtime_unavailable' })
  })
  it('permits Claude Teams through the guest Claude executable', async () => {
    detectInstalled.mockResolvedValue(['claude'])
    await expect(
      validateWorkerAgentForWorktree(runtime(uncFolder), store(), 'claude-agent-teams', folder.id)
    ).resolves.toBeUndefined()
  })
  it('does not apply the Teams fallback to a missing explicit guest executable', async () => {
    detectInstalled.mockResolvedValue(['claude'])
    const settings = store({
      agentCmdOverrides: { 'claude-agent-teams': '~/bin/missing-claude --teams' }
    })
    await expect(
      validateWorkerAgentForWorktree(runtime(uncFolder), settings, 'claude-agent-teams', folder.id)
    ).rejects.toMatchObject({ code: 'agent_not_available' })
  })
})
