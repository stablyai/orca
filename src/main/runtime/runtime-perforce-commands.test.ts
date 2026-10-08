import { beforeEach, describe, expect, it, vi } from 'vitest'
import { currentPerforceSettings } from '../../shared/perforce/p4-settings-context'
import { localPerforceBackend } from '../../shared/perforce/perforce-backend'
import { normalizePerforceSettings } from '../../shared/perforce/perforce-settings'
import type { ExecutionHostId } from '../../shared/execution-host'
import { RuntimePerforceCommands } from './runtime-perforce-commands'

const backendCalls: { connectionId: string | null; cwd: string; p4Path: string; port: string }[] =
  []

vi.mock('../perforce/perforce-ssh-backend', () => ({
  resolvePerforceBackend: (connectionId?: string | null) => ({
    ...localPerforceBackend,
    status: async (cwd: string) => {
      const settings = currentPerforceSettings()
      backendCalls.push({
        connectionId: connectionId ?? null,
        cwd,
        p4Path: settings.p4Path,
        port: settings.p4Port
      })
      return { entries: [], changelists: [], shelvedChangelists: [] }
    }
  })
}))

function commands(executionHostId: ExecutionHostId) {
  const resolveRuntimeFileTarget = vi.fn(async () => ({
    worktree: { path: 'D:\\ws.wt\\copy-1' },
    executionHostId
  }))
  return {
    resolveRuntimeFileTarget,
    commands: new RuntimePerforceCommands({
      resolveRuntimeFileTarget,
      getRuntimeSettings: () => ({
        perforce: normalizePerforceSettings({ p4Path: 'C:\\p4\\p4.exe', p4Port: 'host:1666' })
      })
    })
  }
}

beforeEach(() => {
  backendCalls.length = 0
})

describe('RuntimePerforceCommands', () => {
  it("runs in the selected workspace on this host, with the client's settings and the host's p4", async () => {
    const { commands: runtime, resolveRuntimeFileTarget } = commands('local')
    await runtime.runPerforceOperation('id:repo-1::D:\\ws.wt\\copy-1', 'status', {
      settings: { p4Path: '', p4Port: 'client:1666' }
    })
    expect(resolveRuntimeFileTarget).toHaveBeenCalledWith('id:repo-1::D:\\ws.wt\\copy-1')
    expect(backendCalls).toEqual([
      {
        connectionId: null,
        cwd: 'D:\\ws.wt\\copy-1',
        p4Path: 'C:\\p4\\p4.exe',
        port: 'client:1666'
      }
    ])
  })

  it("uses the host's own settings for a client that sends none", async () => {
    await commands('local').commands.runPerforceOperation('id:wt', 'status', {})
    expect(backendCalls[0]?.port).toBe('host:1666')
  })

  it("reaches a workspace on one of the host's SSH targets over that target's relay", async () => {
    await commands('ssh:build-box').commands.runPerforceOperation('id:wt', 'status', {})
    expect(backendCalls[0]?.connectionId).toBe('build-box')
  })

  it('never dispatches a workspace another Orca server owns', async () => {
    await expect(
      commands('runtime:env-2').commands.runPerforceOperation('id:wt', 'status', {})
    ).rejects.toThrow('is not dispatched by this process')
    expect(backendCalls).toEqual([])
  })
})
