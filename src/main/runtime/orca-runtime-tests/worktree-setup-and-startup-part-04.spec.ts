import '../../../shared/constants'
import { describe, expect, it, vi } from 'vitest'
import '../../../shared/setup-agent-sequencing'
import './runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../orca-runtime'

import {
  computeWorktreePathMock,
  detectInstalledAgentsWithShellPathHydrationMock,
  ensurePathWithinWorkspaceMock
} from '../orca-runtime-test-mocks/setup.spec'
import '../../workspace-hooks/worktree-runner-script'
import '../../workspace-hooks/hooks'
import { listWorktrees } from '../../git/worktrees/catalog/worktree-scan-cache'
import '../../workspace-hooks/effective-hook-config'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'

import { TEST_REPO_ID, makeWorktreeMeta, store } from './orca-runtime-test-fixtures.spec'
import '../terminal/launch/spawned-pty-env-fixtures'
import type { HostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import '../../../shared/layout-owner-switch'
import '../../../shared/workspace-layout/terminal-pane-layout-tree'
import './orca-runtime-layout-owner-start-fixture'

describe('OrcaRuntimeService', () => {
  it('does not send stdin-after-start prompts into a shell when the agent never starts', async () => {
    vi.useFakeTimers()
    try {
      const metaById: Record<string, WorktreeMeta> = {}
      const runtimeStore = {
        ...store,
        getSettings: () => ({
          ...store.getSettings(),
          agentCmdOverrides: {}
        }),
        getAllWorktreeMeta: () => metaById,
        getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
        setWorktreeMeta: ({ id: worktreeId }: HostWorktreeTarget, meta: Partial<WorktreeMeta>) => {
          metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
          return metaById[worktreeId]
        }
      }
      const runtime = new OrcaRuntimeService(runtimeStore as never)
      const write = vi.fn().mockReturnValue(true)
      runtime.setPtyController({
        spawn: vi.fn().mockResolvedValue({ id: 'pty-cli-aider-shell' }),
        write,
        kill: () => true,
        getForegroundProcess: async () => 'zsh',
        hasChildProcesses: vi.fn().mockResolvedValue(false)
      })
      runtime.setNotifier({
        worktreesChanged: vi.fn(),
        reposChanged: vi.fn(),
        activateWorktree: vi.fn(),
        createTerminal: vi.fn(),
        revealTerminalSession: vi.fn().mockResolvedValue({ tabId: 'tab-cli-aider-shell' }),
        splitTerminal: vi.fn(),
        renameTerminal: vi.fn(),
        focusTerminal: vi.fn(),
        closeTerminal: vi.fn(),
        terminalFitOverrideChanged: vi.fn(),
        terminalDriverChanged: vi.fn()
      })
      runtime.attachWindow(1)

      computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-cli-aider-shell')
      ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-cli-aider-shell')
      vi.mocked(listWorktrees).mockResolvedValue([
        {
          path: '/tmp/workspaces/runtime-cli-aider-shell',
          head: 'def',
          branch: 'runtime-cli-aider-shell',
          isBare: false,
          isMainWorktree: false
        }
      ])

      await runtime.createManagedWorktree({
        repoSelector: TEST_REPO_ID,
        name: 'runtime-cli-aider-shell',
        startupAgent: 'aider',
        startupPrompt: 'fix it'
      })

      await vi.advanceTimersByTimeAsync(6000)

      expect(write).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets explicit startup draft agents override the desktop default', async () => {
    detectInstalledAgentsWithShellPathHydrationMock.mockResolvedValue([])
    const metaById: Record<string, WorktreeMeta> = {}
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        defaultTuiAgent: 'claude' as const,
        agentCmdOverrides: {}
      }),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: ({ id: worktreeId }: HostWorktreeTarget, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-explicit-draft' })
    const write = vi.fn().mockReturnValue(true)
    runtime.setPtyController({
      spawn,
      write,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn().mockResolvedValue({ tabId: 'tab-explicit-draft' }),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-explicit-draft')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-explicit-draft')
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-explicit-draft',
        head: 'def',
        branch: 'runtime-explicit-draft',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const draftUrl = 'https://github.com/stablyai/orca/issues/789'
    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-explicit-draft',
      startupDraft: draftUrl,
      startupLaunchSource: 'cli',
      createdWithAgent: 'codex',
      activate: true
    })

    expect(detectInstalledAgentsWithShellPathHydrationMock).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/tmp/workspaces/runtime-explicit-draft',
        command:
          "codex '-c' 'disable_paste_burst=true' '--dangerously-bypass-approvals-and-sandbox'",
        worktreeId: result.worktree.id,
        telemetry: { agent_kind: 'codex', launch_source: 'cli', request_kind: 'new' }
      })
    )
    expect(metaById[result.worktree.id]).toMatchObject({ createdWithAgent: 'codex' })

    runtime.onPtyData('pty-explicit-draft', '\x1b[?2004h›', Date.now())
    await vi.waitFor(() => {
      expect(write).toHaveBeenCalledWith(
        'pty-explicit-draft',
        `\x1b[200~${draftUrl}\x1b[201~`,
        'launch'
      )
    })
  })
})
