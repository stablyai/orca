import { describe, expect, it, vi } from 'vitest'
import {
  provisionWorktreeTerminals,
  type WorktreeTerminalProvisioningHost
} from './runtime-worktree-terminal-provisioning'

const DEFAULT_TABS = {
  runCommands: true,
  tabs: [
    { title: 'Dev', command: 'pnpm dev', color: '#ff0000' },
    { title: 'Tests', command: 'pnpm test', color: '#00ff00' }
  ]
}


const setup = { runnerScriptPath: '/repo/.orca/setup.sh', envVars: {} }

function createHost(settings: Record<string, unknown> = {}): {
  host: WorktreeTerminalProvisioningHost
  titles: () => (string | undefined)[]
} {
  const createTerminal = vi.fn<WorktreeTerminalProvisioningHost['createTerminal']>(async () => ({
    handle: `term-${createTerminal.mock.calls.length}`
  }))
  return {
    host: {
      canSpawn: () => true,
      createTerminal,
      setTabTitle: vi.fn(async () => {}),
      setTabColor: vi.fn(async () => {}),
      getSettings: () =>
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: provisioning reads only the optional keys each test supplies.
        settings as ReturnType<NonNullable<WorktreeTerminalProvisioningHost['getSettings']>>,
      getPtyId: () => undefined,
      recordSetupCompletionToken: vi.fn()
    },
    titles: () => createTerminal.mock.calls.map(([, options]) => options.title)
  }
}

function provisionWithSetup(
  host: WorktreeTerminalProvisioningHost,
  withSetup = true,
  setupOnly?: boolean,
  defaultTabs?: typeof DEFAULT_TABS,
  callerProvidesSurface = false
) {
  return provisionWorktreeTerminals(host, {
    worktreeSelector: 'id:wt-1',
    worktreeId: 'wt-1',
    worktreePath: '/repo/wt-1',
    ...(withSetup ? { setup } : {}),
    hasStartupTerminal: false,
    ...(setupOnly !== undefined ? { setupOnly } : {}),
    ...(defaultTabs ? { defaultTabs } : {}),
    callerProvidesSurface,
    setupCommandPlatform: 'posix'
  })
}


describe('provisionWorktreeTerminals setup auto-close', () => {
  it('makes host-created setup terminals exit their shell on success only when enabled', async () => {
    const off = createHost({}).host
    await provisionWithSetup(off)
    expect(off.createTerminal).toHaveBeenCalledWith(
      'id:wt-1',
      expect.objectContaining({ command: 'bash /repo/.orca/setup.sh' })
    )

    const on = createHost({ closeSetupTabOnSuccess: true }).host
    await provisionWithSetup(on)
    expect(on.createTerminal).toHaveBeenCalledWith(
      'id:wt-1',
      expect.objectContaining({ command: 'bash /repo/.orca/setup.sh && exit 79' })
    )
  })
})
