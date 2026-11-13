import { describe, expect, it } from 'vitest'
import { availableWorkspaceAgents } from './plugin-host-available-agents'
import type { PluginRuntimeRpc } from './plugin-host-runtime-call'

describe('available workspace agents', () => {
  it('probes the selected checkout host and excludes disabled or unknown agents', async () => {
    const probes: unknown[] = []
    const runtimeRpc: PluginRuntimeRpc = async (method, params) => {
      if (method === 'worktree.show') {
        return {
          worktree: {
            id: 'repo::/workspace',
            hostId: 'ssh:devbox',
            identity: { key: 'wt2:ssh%3Adevbox:checkout', executionHostId: 'ssh:devbox' }
          }
        }
      }
      if (method === 'settings.getAgentLaunch') {
        return { settings: { disabledTuiAgents: ['gemini'] } }
      }
      if (method === 'preflight.detectAgents') {
        probes.push(params)
        return ['codex', 'gemini', 'claude', 'codex', 'unregistered-command']
      }
      throw new Error(`Unexpected method ${method}`)
    }
    await expect(
      availableWorkspaceAgents({ runtimeRpc }, 'identity:wt2:ssh%3Adevbox:checkout')
    ).resolves.toEqual({
      agents: [
        { id: 'codex', label: 'Codex' },
        { id: 'claude', label: 'Claude' }
      ]
    })
    expect(probes).toEqual([{ worktreeId: 'repo::/workspace', worktreeHostId: 'ssh:devbox' }])
  })

  it('uses the folder owner without requiring a git checkout', async () => {
    const probes: unknown[] = []
    const runtimeRpc: PluginRuntimeRpc = async (method, params) => {
      if (method === 'folderWorkspace.list') {
        return { folderWorkspaces: [{ id: 'notes', executionHostId: 'ssh:remote' }] }
      }
      if (method === 'settings.getAgentLaunch') {
        return { settings: { disabledTuiAgents: [] } }
      }
      if (method === 'preflight.detectAgents') {
        probes.push(params)
        return ['codex']
      }
      throw new Error(`Unexpected method ${method}`)
    }
    await expect(availableWorkspaceAgents({ runtimeRpc }, 'folder:notes')).resolves.toEqual({
      agents: [{ id: 'codex', label: 'Codex' }]
    })
    expect(probes).toEqual([{ worktreeId: 'folder:notes', worktreeHostId: 'ssh:remote' }])
  })

  it('refuses a replaced checkout or ambiguous folder before probing another host', async () => {
    const runtimeRpc: PluginRuntimeRpc = async (method) => {
      if (method === 'worktree.show') {
        return {
          worktree: {
            id: 'repo::/workspace',
            hostId: 'local',
            identity: { key: 'wt2:local:replacement', executionHostId: 'local' }
          }
        }
      }
      if (method === 'folderWorkspace.list') {
        return {
          folderWorkspaces: [
            { id: 'notes', executionHostId: 'local' },
            { id: 'notes', executionHostId: 'ssh:remote' }
          ]
        }
      }
      throw new Error('Unexpected detection on an unverified host')
    }
    await expect(
      availableWorkspaceAgents({ runtimeRpc }, 'identity:wt2:local:original')
    ).rejects.toThrow('execution host changed')
    await expect(availableWorkspaceAgents({ runtimeRpc }, 'folder:notes')).rejects.toThrow(
      'no unique execution host'
    )
  })
})
