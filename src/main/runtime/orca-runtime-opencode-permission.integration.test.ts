import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../agent-hooks/server'
import { makePaneKey } from '../../shared/stable-pane-id'
import { OrcaRuntimeService } from './orca-runtime'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const TAB_ID = 'permission-tab'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)
const WORKTREE_ID = 'permission-worktree'
const PTY_ID = 'permission-pty'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('OpenCode permission hook Runtime projection', () => {
  it('carries a safe interaction through the live hook server to session.tabs', async () => {
    const hookServer = new AgentHookServer()
    await hookServer.start({ env: 'production' })
    try {
      const env = hookServer.buildPtyEnv()
      const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/opencode`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
        },
        body: JSON.stringify({
          paneKey: PANE_KEY,
          tabId: TAB_ID,
          worktreeId: WORKTREE_ID,
          env: 'production',
          payload: {
            hook_event_name: 'PermissionRequest',
            id: 'opaque-request-id',
            sessionID: 'canonical-session-id'
          }
        })
      })
      expect(response.status).toBe(204)

      const runtime = new OrcaRuntimeService(null, undefined, {
        getAgentStatusSnapshot: () => hookServer.getStatusSnapshot()
      })
      const internals = runtime as unknown as {
        resolveTerminalWorkspaceLaunchScope: (selector: string) => Promise<unknown>
      }
      vi.spyOn(internals, 'resolveTerminalWorkspaceLaunchScope').mockResolvedValue({
        id: WORKTREE_ID,
        path: '/repo/app',
        connectionId: null,
        repo: null,
        folderWorkspace: null
      })
      runtime.setPtyController({
        spawn: vi.fn().mockResolvedValue({ id: PTY_ID }),
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null
      })
      await runtime.createTerminal(`id:${WORKTREE_ID}`, {
        tabId: TAB_ID,
        leafId: LEAF_ID,
        launchAgent: 'opencode',
        title: 'Terminal'
      })
      runtime.onPtyData(PTY_ID, '\u001b]0;bash\u0007', Date.now())

      const result = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
      const tab = result.tabs[0]
      const serialized = JSON.stringify(tab)

      expect(tab?.type === 'terminal' && tab.agentStatus).toEqual(
        expect.objectContaining({
          state: 'waiting',
          agentType: 'opencode',
          interaction: { kind: 'permission' },
          providerSession: { key: 'session_id', id: 'canonical-session-id' }
        })
      )
      expect(serialized).not.toContain('opaque-request-id')
      expect(
        tab?.type === 'terminal' ? Object.keys(tab.agentStatus?.interaction ?? {}) : []
      ).toEqual(['kind'])
    } finally {
      hookServer.stop()
    }
  })
})
