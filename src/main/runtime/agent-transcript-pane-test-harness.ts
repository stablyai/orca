import { vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type { TuiAgent } from '../../shared/tui-agent'
import type { PtyProcessInspection } from '../providers/pty-process-inspection'
import type { RuntimeStore } from './runtime-store-contract'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'
import { committingSpawn, registerBoundPty } from './bind-first-pane.test-fixture'

const TRANSCRIPT_PANE_LEAF_ID = '11111111-1111-4111-8111-111111111111'
const TRANSCRIPT_PANE_TAB_ID = 'tab-1'
const TRANSCRIPT_PANE_WORKTREE_ID = 'wt-1'
export const TRANSCRIPT_PANE_PTY_ID = 'pty-1'

export type TranscriptPaneOptions = {
  paneTitle: string
  foregroundProcess: string | null
  data: string
  launchAgent?: TuiAgent
  connectionId?: string
  remoteWindowsHost?: boolean
  foregroundProbeHangs?: boolean
  onForegroundProbe?: () => void
  /** Controller grid size; the runtime emulator defaults to 80x24. */
  size?: { cols: number; rows: number }
  confirmedForegroundProcess?: string | null
  onForegroundScan?: () => void
  processInspection?: PtyProcessInspection
  onProcessInspection?: () => void
  shellForegroundProven?: boolean
  paneRootPid?: number
  onShellForegroundProof?: () => void
}

function transcriptLayoutStore(): RuntimeStore {
  return {
    getRepos: () => [],
    getRepo: () => undefined,
    addRepo: vi.fn<RuntimeStore['addRepo']>(),
    updateRepo: vi.fn<RuntimeStore['updateRepo']>(),
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => undefined,
    setWorktreeMeta: vi.fn<RuntimeStore['setWorktreeMeta']>(),
    removeWorktreeMeta: vi.fn<RuntimeStore['removeWorktreeMeta']>(),
    getGitHubCache: vi.fn<RuntimeStore['getGitHubCache']>(),
    getSettings: () => ({
      workspaceDir: '/workspaces',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      branchPrefix: 'none',
      branchPrefixCustom: ''
    })
  }
}

export async function createTranscriptPane(
  options: TranscriptPaneOptions,
  runtimeDeps?: ConstructorParameters<typeof OrcaRuntimeService>[2]
): Promise<{ runtime: OrcaRuntimeService; handle: string }> {
  const runtime = new OrcaRuntimeService(
    ORCA_LAYOUT_OWNER_IS_MAIN ? transcriptLayoutStore() : null,
    undefined,
    runtimeDeps
  )
  // The runtime reads a remote pane's host OS from its worktree path.
  const worktreeId = options.remoteWindowsHost
    ? 'repo-1::C:\\repo\\app'
    : TRANSCRIPT_PANE_WORKTREE_ID
  const internals = runtime as unknown as {
    resolveTerminalWorkspaceLaunchScope: (selector: string) => Promise<unknown>
  }
  vi.spyOn(internals, 'resolveTerminalWorkspaceLaunchScope').mockResolvedValue({
    id: worktreeId,
    path: '/repo/app',
    connectionId: options.connectionId ?? null,
    repo: null,
    folderWorkspace: null
  })
  const processInspection = options.processInspection
  runtime.setPtyController({
    spawn: committingSpawn(
      runtime,
      vi.fn(async (_args: { worktreeId?: string; tabId?: string; leafId?: string }) => ({
        id: TRANSCRIPT_PANE_PTY_ID,
        incarnationId: 'inc-1'
      }))
    ),
    write: () => true,
    kill: () => true,
    getSize: () => options.size ?? null,
    getForegroundProcess: (): Promise<string | null> => {
      options.onForegroundProbe?.()
      return options.foregroundProbeHangs === true
        ? new Promise<string | null>(() => {})
        : Promise.resolve(options.foregroundProcess)
    },
    ...(options.confirmedForegroundProcess !== undefined
      ? {
          confirmForegroundProcess: async () => {
            options.onForegroundScan?.()
            return options.confirmedForegroundProcess ?? null
          }
        }
      : {}),
    ...(processInspection
      ? {
          inspectProcess: async () => {
            options.onProcessInspection?.()
            return processInspection
          }
        }
      : {}),
    ...(options.paneRootPid !== undefined
      ? {
          listProcesses: async () => [
            {
              id: TRANSCRIPT_PANE_PTY_ID,
              rootProcessId: options.paneRootPid,
              cwd: '/repo/app',
              title: 'Terminal'
            }
          ]
        }
      : {}),
    ...(options.shellForegroundProven !== undefined
      ? {
          confirmShellForeground: async () => {
            options.onShellForegroundProof?.()
            return options.shellForegroundProven === true
          }
        }
      : {})
  })
  const terminal = await runtime.createTerminal(`id:${worktreeId}`, {
    tabId: TRANSCRIPT_PANE_TAB_ID,
    leafId: TRANSCRIPT_PANE_LEAF_ID,
    title: 'Terminal'
  })
  runtime.attachWindow(1)
  runtime.syncWindowGraph(
    1,
    ORCA_LAYOUT_OWNER_IS_MAIN
      ? {
          tabs: [],
          leaves: [],
          mountedLeaves: [
            {
              tabId: TRANSCRIPT_PANE_TAB_ID,
              leafId: TRANSCRIPT_PANE_LEAF_ID,
              paneRuntimeId: 1,
              paneTitle: options.paneTitle
            }
          ]
        }
      : {
          tabs: [
            {
              tabId: TRANSCRIPT_PANE_TAB_ID,
              worktreeId,
              title: 'Terminal',
              activeLeafId: TRANSCRIPT_PANE_LEAF_ID,
              layout: null
            }
          ],
          leaves: [
            {
              tabId: TRANSCRIPT_PANE_TAB_ID,
              worktreeId,
              leafId: TRANSCRIPT_PANE_LEAF_ID,
              paneRuntimeId: 1,
              ptyId: TRANSCRIPT_PANE_PTY_ID,
              paneTitle: options.paneTitle
            }
          ]
        }
  )
  if (options.launchAgent) {
    registerBoundPty(runtime, TRANSCRIPT_PANE_PTY_ID, worktreeId, options.connectionId ?? null, {
      tabId: TRANSCRIPT_PANE_TAB_ID,
      leafId: TRANSCRIPT_PANE_LEAF_ID,
      incarnationId: 'inc-1',
      agentLaunchAuthority: { launchToken: 'transcript-launch', launchAgent: options.launchAgent }
    })
  }
  // Restore seeds apply only to never-written records; do not write an empty chunk first.
  if (options.data.length > 0) {
    runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, options.data, Date.now())
  }
  return { runtime, handle: terminal.handle }
}

export async function waitForTranscriptIdle(
  pane: Awaited<ReturnType<typeof createTranscriptPane>>,
  timeoutMs: number
) {
  vi.useFakeTimers({
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']
  })
  try {
    const waiting = pane.runtime.waitForTerminal(pane.handle, { condition: 'tui-idle', timeoutMs })
    // Expected refusals must have a rejection handler before advancing their deadline.
    void waiting.catch(() => {})
    await vi.advanceTimersByTimeAsync(timeoutMs)
    return await waiting
  } finally {
    vi.useRealTimers()
  }
}
