// One pane builder for every suite that replays a captured agent transcript through the runtime.
import { vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type { TuiAgent } from '../../shared/tui-agent'
import type { PtyProcessInspection } from '../providers/pty-process-inspection'

const TRANSCRIPT_PANE_LEAF_ID = '11111111-1111-4111-8111-111111111111'
const TRANSCRIPT_PANE_TAB_ID = 'tab-1'
const TRANSCRIPT_PANE_WORKTREE_ID = 'wt-1'
export const TRANSCRIPT_PANE_PTY_ID = 'pty-1'

export type TranscriptPaneOptions = {
  paneTitle: string
  foregroundProcess: string | null
  data: string
  launchAgent?: TuiAgent
  /** Set for a pane whose PTY lives on an SSH host or WSL distro rather than locally. */
  connectionId?: string
  /** The remote host of a `connectionId` pane is Windows. */
  remoteWindowsHost?: boolean
  /** Simulates a PTY controller whose foreground probe never settles. */
  foregroundProbeHangs?: boolean
  onForegroundProbe?: () => void
  /** PTY grid the controller reports; the runtime's emulator otherwise defaults to 80x24. */
  size?: { cols: number; rows: number }
  /** What a fresh foreground scan finds, where it differs from the cached foreground read. */
  confirmedForegroundProcess?: string | null
  onForegroundScan?: () => void
  /** What the host's process inspection answers; absent for a host without one. */
  processInspection?: PtyProcessInspection
  onProcessInspection?: () => void
  /** What the host's shell-foreground check answers: the spawned shell holds the foreground. */
  shellForegroundProven?: boolean
  /** The pane's root process the provider reports; absent for a provider without an inventory. */
  paneRootPid?: number
  onShellForegroundProof?: () => void
}

export async function createTranscriptPane(
  options: TranscriptPaneOptions,
  runtimeDeps?: ConstructorParameters<typeof OrcaRuntimeService>[2]
): Promise<{ runtime: OrcaRuntimeService; handle: string }> {
  const runtime = new OrcaRuntimeService(null, undefined, runtimeDeps)
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
    spawn: vi.fn().mockResolvedValue({ id: TRANSCRIPT_PANE_PTY_ID, incarnationId: 'inc-1' }),
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
  runtime.syncWindowGraph(1, {
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
  })
  if (options.launchAgent) {
    runtime.registerPty(TRANSCRIPT_PANE_PTY_ID, worktreeId, options.connectionId ?? null, {
      tabId: TRANSCRIPT_PANE_TAB_ID,
      leafId: TRANSCRIPT_PANE_LEAF_ID,
      incarnationId: 'inc-1',
      agentLaunchAuthority: { launchToken: 'transcript-launch', launchAgent: options.launchAgent }
    })
  }
  // Why the guard: a restore seed is only applied to a never-written record, so the restore
  // cases must not write an empty chunk first.
  if (options.data.length > 0) {
    runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, options.data, Date.now())
  }
  return { runtime, handle: terminal.handle }
}

/** Advance readiness deadlines after real pane creation and emulator drains. */
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
