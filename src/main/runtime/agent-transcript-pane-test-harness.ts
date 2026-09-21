// One pane builder for every suite that replays a captured agent transcript through the runtime.
import { vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'

const TRANSCRIPT_PANE_LEAF_ID = '11111111-1111-4111-8111-111111111111'
const TRANSCRIPT_PANE_TAB_ID = 'tab-1'
const TRANSCRIPT_PANE_WORKTREE_ID = 'wt-1'
export const TRANSCRIPT_PANE_PTY_ID = 'pty-1'

export type TranscriptPaneOptions = {
  paneTitle: string
  foregroundProcess: string | null
  data: string
  /** Set for a pane whose PTY lives on an SSH host or WSL distro rather than locally. */
  connectionId?: string
  /** Simulates a PTY controller whose foreground probe never settles. */
  foregroundProbeHangs?: boolean
  onForegroundProbe?: () => void
}

export async function createTranscriptPane(
  options: TranscriptPaneOptions,
  runtimeDeps?: ConstructorParameters<typeof OrcaRuntimeService>[2]
): Promise<{ runtime: OrcaRuntimeService; handle: string }> {
  const runtime = new OrcaRuntimeService(null, undefined, runtimeDeps)
  const internals = runtime as unknown as {
    resolveTerminalWorkspaceLaunchScope: (selector: string) => Promise<unknown>
  }
  vi.spyOn(internals, 'resolveTerminalWorkspaceLaunchScope').mockResolvedValue({
    id: TRANSCRIPT_PANE_WORKTREE_ID,
    path: '/repo/app',
    connectionId: options.connectionId ?? null,
    repo: null,
    folderWorkspace: null
  })
  runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: TRANSCRIPT_PANE_PTY_ID, incarnationId: 'inc-1' }),
    write: () => true,
    kill: () => true,
    getForegroundProcess: (): Promise<string | null> => {
      options.onForegroundProbe?.()
      return options.foregroundProbeHangs === true
        ? new Promise<string | null>(() => {})
        : Promise.resolve(options.foregroundProcess)
    }
  })
  const terminal = await runtime.createTerminal(`id:${TRANSCRIPT_PANE_WORKTREE_ID}`, {
    tabId: TRANSCRIPT_PANE_TAB_ID,
    leafId: TRANSCRIPT_PANE_LEAF_ID,
    title: 'Terminal'
  })
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: TRANSCRIPT_PANE_TAB_ID,
        worktreeId: TRANSCRIPT_PANE_WORKTREE_ID,
        title: 'Terminal',
        activeLeafId: TRANSCRIPT_PANE_LEAF_ID,
        layout: null
      }
    ],
    leaves: [
      {
        tabId: TRANSCRIPT_PANE_TAB_ID,
        worktreeId: TRANSCRIPT_PANE_WORKTREE_ID,
        leafId: TRANSCRIPT_PANE_LEAF_ID,
        paneRuntimeId: 1,
        ptyId: TRANSCRIPT_PANE_PTY_ID,
        paneTitle: options.paneTitle
      }
    ]
  })
  // Why the guard: a restore seed is only applied to a never-written record, so the restore
  // cases must not write an empty chunk first.
  if (options.data.length > 0) {
    runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, options.data, Date.now())
  }
  return { runtime, handle: terminal.handle }
}
