import { OrcaRuntimeWithRestoredHandlePaneStart } from '../surface/restored-handle-pane-start'
import type * as Read from '../../../../shared/runtime-types'
import type {
  RuntimeProviderSnapshotReadOptions,
  TerminalHandleRecord
} from '../../runtime-terminal-contracts'
import type {
  RuntimeLeafRecord,
  RuntimePtyWorktreeRecord
} from '../../runtime-terminal-state-records'
import { labelTerminalReadSource, readTerminalTail } from '../../terminal-tail-read'
import { getTerminalState } from '../../terminal-wait-results'
import { readStructuredWorkerTerminal } from '../../structured-worker-terminal-read'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'

export abstract class OrcaRuntimeWithReadTerminalPane extends OrcaRuntimeWithRestoredHandlePaneStart {
  protected abstract assertLiveTerminalHandleTargetsPty(handle: string, expectedPtyId: string): void

  protected abstract getLiveLeafForHandle(handle: string): {
    record: TerminalHandleRecord
    leaf: RuntimeLeafRecord
  }

  protected abstract readPtyTerminal(
    handle: string,
    pty: RuntimePtyWorktreeRecord,
    opts?: { cursor?: number; limit?: number }
  ): Read.RuntimeTerminalRead

  async readTerminal(
    handle: string,
    opts: { cursor?: number; limit?: number; screen?: boolean } = {},
    providerSnapshot: RuntimeProviderSnapshotReadOptions = {}
  ): Promise<Read.RuntimeTerminalRead> {
    // Before the PTY lookup, because a structured worker has no PTY and no leaf: without this the
    // only peer read verb answers `terminal_handle_stale` for a perfectly live worker.
    const structured = await readStructuredWorkerTerminal({
      handle,
      db: this.getOrchestrationDbIfAvailable?.() ?? null,
      ...(opts.cursor === undefined ? {} : { cursor: opts.cursor }),
      ...(opts.limit === undefined ? {} : { limit: opts.limit })
    })
    if (structured) {
      // `screen` asks for a rendered grid; there is none, and the journal is the whole record.
      return { ...structured, source: opts.screen ? 'screen-unavailable' : 'stream' }
    }
    // Switch point: a saved pane main holds with no terminal yet starts first (once, shared).
    const starting = ORCA_LAYOUT_OWNER_IS_MAIN ? this.startRestoredHandlePane(handle) : null
    if (starting) {
      const target = await starting
      return { ...(await this.readTerminal(target, opts, providerSnapshot)), handle }
    }
    const pty = this.getLivePtyForHandle(handle)
    if (pty) {
      const read = this.readPtyTerminal(handle, pty.pty, opts)
      const visibleRead = opts.screen
        ? await this.readRenderedScreen(pty.pty.ptyId, read, opts)
        : await this.withVisibleSnapshotFallback(pty.pty.ptyId, read, opts, providerSnapshot)
      this.assertLiveTerminalHandleTargetsPty(handle, pty.pty.ptyId)
      return labelTerminalReadSource(visibleRead)
    }

    const { leaf } = this.getLiveLeafForHandle(handle)
    const read = readTerminalTail({
      handle,
      status: getTerminalState(leaf),
      previewLines: leaf.tailBuffer,
      completedLines: leaf.tailTranscriptBuffer,
      partialLine: leaf.tailPartialLine,
      completedLineCount: leaf.tailLinesTotal,
      bufferTruncated: leaf.tailTruncated,
      cursor: opts.cursor,
      limit: opts.limit
    })
    if (!leaf.ptyId) {
      return { ...read, source: opts.screen ? 'screen-unavailable' : 'stream' }
    }
    const visibleRead = opts.screen
      ? await this.readRenderedScreen(leaf.ptyId, read, opts)
      : await this.withVisibleSnapshotFallback(leaf.ptyId, read, opts, providerSnapshot)
    this.assertLiveTerminalHandleTargetsPty(handle, leaf.ptyId)
    return labelTerminalReadSource(visibleRead)
  }
}
