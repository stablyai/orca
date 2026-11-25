import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { OrcaUninstallPlan } from '../../shared/uninstall/orca-uninstall-types'

// In an app profile, every writer to the shared agent config stays off. The home is a temp
// folder and the writers are spies, so a broken guard cannot reach the real home.
const { openCodeRefresh } = vi.hoisted(() => ({ openCodeRefresh: vi.fn() }))
vi.mock('../opencode/status-hooks/hook-service', () => ({
  openCodeHookService: { refreshInstalledPlugins: openCodeRefresh },
  openCode2HookService: { refreshInstalledPlugins: openCodeRefresh }
}))

import { ClaudeAgentViewService } from '../claude/agent-view/agent-view-service'
import { refreshInstalledOpenCodeStatusPlugins } from '../opencode/status-hooks/opencode-status-plugin-startup-refresh'
import { startClaudeCodeThemeSync } from '../claude/theme-sync/claude-code-theme-sync-schedule'
import { runOrcaUninstallStep, type OrcaUninstallHost } from '../uninstall/orca-uninstall-cleanup'

let home: string

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-profile-writers-'))
  vi.stubEnv('HOME', home)
  vi.stubEnv('ORCA_HOME_DIR', join(home, 'profile', 'orca-home'))
})

afterAll(() => {
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

const settings = { agentStatusHooksEnabled: true }

function uninstallPlan(changes: Partial<OrcaUninstallPlan>): OrcaUninstallPlan {
  return {
    installKind: 'mac-app',
    agents: [],
    cliCommand: null,
    backgroundService: null,
    hookScripts: null,
    hosts: [],
    terminalDaemon: null,
    otherOrcaBuildName: null,
    appPath: null,
    removeAppCommand: null,
    ...changes
  }
}

function uninstallHost(): OrcaUninstallHost {
  const refuse = async (): Promise<never> => {
    throw new Error('A profile must not reach this')
  }
  return {
    platform: 'darwin',
    homeDir: home,
    userDataPath: join(home, 'profile'),
    uid: 501,
    identity: {
      installKind: 'mac-app',
      appPath: null,
      removeAppCommand: null,
      otherOrcaBuildName: null
    },
    disableAgentStatusHooks: vi.fn(refuse),
    getCliStatus: async () => null,
    removeCli: vi.fn(refuse),
    listHosts: async () => [],
    removeHostHooks: refuse,
    isTerminalDaemonLive: async () => false,
    stopTerminalDaemon: refuse
  }
}

describe('shared agent writers in an app profile', () => {
  it('does not reconcile the Claude agent view', async () => {
    const claudeOnPath = vi.fn(async () => true)
    const listProfiles = vi.fn(async () => [])
    const service = new ClaudeAgentViewService(home, {
      reconcileConfig: vi.fn(),
      ensurePlugin: vi.fn(),
      listProfiles,
      loginEnv: vi.fn(),
      claudeOnPath
    })
    await service.reconcile(settings)
    expect(claudeOnPath).not.toHaveBeenCalled()
    expect(listProfiles).not.toHaveBeenCalled()
  })

  it('does not refresh the OpenCode status plugins', () => {
    refreshInstalledOpenCodeStatusPlugins(settings)
    expect(openCodeRefresh).not.toHaveBeenCalled()
  })

  it('does not start the Claude Code theme sync', () => {
    const getSettings = vi.fn<Parameters<typeof startClaudeCodeThemeSync>[0]['getSettings']>()
    const onSettingsChanged = vi.fn()
    startClaudeCodeThemeSync({
      getSettings,
      onSettingsChanged,
      systemPrefersDark: () => true,
      onSystemThemeChanged: () => {},
      onAppFocused: () => {},
      userDataPath: home
    })
    expect(getSettings).not.toHaveBeenCalled()
    expect(onSettingsChanged).not.toHaveBeenCalled()
  })

  it("uninstall keeps the default app's hooks, scripts and orca command", async () => {
    const scripts = join(home, '.orca', 'agent-hooks')
    mkdirSync(scripts, { recursive: true })
    writeFileSync(join(scripts, 'claude-hook.sh'), '#!/bin/sh\n')
    const host = uninstallHost()
    const plan = uninstallPlan({
      agents: [{ agent: 'claude', paths: [], state: 'present', detail: null }],
      hookScripts: { location: scripts, state: 'present', detail: null },
      cliCommand: {
        location: '/usr/local/bin/orca',
        commandName: 'orca',
        state: 'present',
        detail: null
      }
    })
    const afterHooks = await runOrcaUninstallStep(plan, 'agent-hooks', host)
    expect(afterHooks.agents[0]?.state).toBe('kept-shared')
    const emptied = uninstallPlan({ hookScripts: plan.hookScripts })
    expect((await runOrcaUninstallStep(emptied, 'hook-scripts', host)).hookScripts?.state).toBe(
      'kept-shared'
    )
    expect((await runOrcaUninstallStep(plan, 'cli-command', host)).cliCommand?.state).toBe(
      'kept-shared'
    )
    expect(host.disableAgentStatusHooks).not.toHaveBeenCalled()
    expect(host.removeCli).not.toHaveBeenCalled()
    expect(existsSync(join(scripts, 'claude-hook.sh'))).toBe(true)
  })
})
