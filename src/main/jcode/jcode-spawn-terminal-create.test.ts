import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../runtime/orca-runtime-test-mocks.spec'
import '../runtime/orca-runtime-test-lifecycle.spec'
import {
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  spawnedPtyEnv,
  store
} from '../runtime/orca-runtime-test-fixtures.spec'
import { buildJcodeRuntimeDir, shouldInjectJcodeRuntimeDir } from '../../shared/jcode-runtime-dir'
import { allocateTerminalPaneIdentity } from '../runtime/runtime-terminal-pane-identity'

describe('Jcode child terminal creation', () => {
  it('preserves command and caller identity but ignores caller token without launch config', async () => {
    const runtime = new OrcaRuntimeService(store)
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pty-root' })
      .mockResolvedValue({ id: 'pty-jcode' })
    const focusTerminal = vi.fn()
    const activateWorktree = vi.fn()
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'ignored' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree,
      createTerminal: vi.fn(),
      revealTerminalSession,
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal,
      closeTerminal: vi.fn(),
      workspaceSleepChanged: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'echo root',
      focus: true
    })
    const before = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(before.activeTabId).not.toBeNull()
    spawn.mockClear()
    focusTerminal.mockClear()
    activateWorktree.mockClear()
    revealTerminalSession.mockClear()
    const pane = allocateTerminalPaneIdentity({})
    const launchToken = randomUUID()
    const command =
      "'/home/user/.local/bin/jcode' '--fresh-spawn' '--provider' 'claude' '--resume' 'session_piglet_1792604760697_211acdce5650ace5'"
    const rootDir = buildJcodeRuntimeDir('root:11111111-1111-4111-8111-111111111111')
    const terminal = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      ...pane,
      command,
      launchAgent: 'jcode',
      launchToken,
      jcodeRuntimeDir: rootDir,
      surfaceOwner: false
    })
    expect(terminal).toMatchObject({ tabId: pane.tabId, paneKey: pane.paneKey })
    expect(spawn.mock.calls[0][0]).toMatchObject({
      command,
      tabId: pane.tabId,
      leafId: pane.leafId,
      cwd: TEST_WORKTREE_PATH
    })
    const env = spawnedPtyEnv(spawn.mock.calls[0][0])
    expect(env.JCODE_RUNTIME_DIR).toBe(
      shouldInjectJcodeRuntimeDir(process.platform) ? rootDir : undefined
    )
    expect(env.ORCA_AGENT_LAUNCH_TOKEN === launchToken).toBe(false)
    expect(focusTerminal).not.toHaveBeenCalled()
    expect(activateWorktree).not.toHaveBeenCalled()
    expect(revealTerminalSession).toHaveBeenCalledWith(
      TEST_WORKTREE_ID,
      expect.objectContaining({ activate: false, tabId: pane.tabId, leafId: pane.leafId })
    )
    expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).activeTabId).toBe(
      before.activeTabId
    )
  })
})
