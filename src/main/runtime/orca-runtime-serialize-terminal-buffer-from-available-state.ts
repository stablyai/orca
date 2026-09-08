// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithCreatePtyHeadlessTerminalState } from './orca-runtime-create-pty-headless-terminal-state'
import type { TerminalOscLinkRange } from '../../shared/terminal-osc-link-ranges'
import type { PtyProviderBufferSnapshot } from '../providers/types'
import { withTimeout } from './runtime-async-boundaries'
import { AUTHORITATIVE_TERMINAL_SNAPSHOT_TIMEOUT_MS } from './orca-runtime-postlude'

export class OrcaRuntimeWithSerializeTerminalBufferFromAvailableState extends OrcaRuntimeWithCreatePtyHeadlessTerminalState {
  protected async serializeTerminalBufferFromAvailableState(
    ptyId: string,
    opts: { scrollbackRows?: number } = {}
  ): Promise<{
    data: string
    frameRestoreAnsi?: string
    cols: number
    rows: number
    cwd?: string | null
    lastTitle?: string
    seq?: number
    source?: 'headless' | 'renderer'
    oscLinks?: TerminalOscLinkRange[]
    alternateScreen?: boolean
    pendingEscapeTailAnsi?: string
    kittyKeyboardFlags?: number
    terminalOwner?: 'shell'
  } | null> {
    const restoredSnapshot = await this.serializePreferredRestoredTerminalBuffer(ptyId, opts)
    if (restoredSnapshot) {
      return restoredSnapshot
    }
    const headlessSnapshot = await this.serializeHeadlessTerminalBuffer(ptyId, opts)
    if (headlessSnapshot) {
      return headlessSnapshot
    }

    const rendererSnapshot = await this.serializeRendererTerminalBuffer(ptyId, opts)
    if (!rendererSnapshot) {
      return this.serializeProviderTerminalBuffer(ptyId, opts)
    }
    if (rendererSnapshot.data.length > 0) {
      return rendererSnapshot
    }
    // Why: parked desktop panes register serializers before their xterm has
    // hydrated. Treat that empty shell as provisional so retained provider
    // history can restore mobile without forcing the desktop pane to mount.
    const providerSnapshot = await this.serializeProviderTerminalBuffer(ptyId, opts)
    return providerSnapshot &&
      (providerSnapshot.data.length > 0 || Boolean(providerSnapshot.scrollbackAnsi))
      ? providerSnapshot
      : rendererSnapshot
  }

  protected async serializePreferredRestoredTerminalBuffer(
    ptyId: string,
    opts: { scrollbackRows?: number } = {}
  ) {
    const mirror = this.headlessTerminals.get(ptyId)
    const needsDeeperHistory = mirror && (opts.scrollbackRows ?? 0) > mirror.emulator.scrollbackRows
    if (!this.providerSnapshotPreferredPtys.has(ptyId) && !needsDeeperHistory) {
      return null
    }
    // Bound optional deep-history acquisition without duplicating an outstanding provider request.
    const provider = await this.serializeProviderTerminalBuffer(ptyId, opts, {
      timeoutMs: AUTHORITATIVE_TERMINAL_SNAPSHOT_TIMEOUT_MS,
      retireOnTimeout: true
    })
    if (provider) {
      return provider
    }
    const renderer = await this.serializeRendererTerminalBuffer(ptyId, opts)
    // A parked renderer can register before hydration; keep the populated mirror in that case.
    return needsDeeperHistory && renderer?.data.length === 0 ? null : renderer
  }

  async serializeRendererTerminalBuffer(
    ptyId: string,
    opts: { scrollbackRows?: number } = {}
  ): Promise<{
    data: string
    frameRestoreAnsi?: string
    cols: number
    rows: number
    seq?: number
    cwd?: string | null
    lastTitle?: string
    source?: 'renderer'
    oscLinks?: TerminalOscLinkRange[]
    kittyKeyboardFlags?: number
  } | null> {
    if (this.ptyController?.hasRendererSerializer?.(ptyId) === false) {
      return null
    }
    let rendererSnapshot: {
      data: string
      cols: number
      rows: number
      seq?: number
      cwd?: string | null
      lastTitle?: string
      oscLinks?: TerminalOscLinkRange[]
      kittyKeyboardFlags?: number
    } | null = null
    try {
      rendererSnapshot = await (this.ptyController?.serializeBuffer?.(ptyId, {
        scrollbackRows: opts.scrollbackRows
      }) ?? Promise.resolve(null))
    } catch {
      // Why: terminal snapshots should not depend on a mounted renderer pane.
      // If renderer serialization races reload/unmount, callers can still use
      // their existing null fallback paths.
    }
    return rendererSnapshot
      ? this.preferTrackedLastTitle(ptyId, {
          ...rendererSnapshot,
          cwd: rendererSnapshot.cwd ?? this.terminalCwdByPtyId.get(ptyId),
          source: 'renderer' as const
        })
      : null
  }

  protected async serializeProviderTerminalBuffer(
    ptyId: string,
    opts: { scrollbackRows?: number } = {},
    wait: { timeoutMs?: number; retireOnTimeout?: boolean } = {}
  ): Promise<PtyProviderBufferSnapshot | null> {
    const generation = this.getPtyLifecycleGeneration(ptyId)
    const scrollbackRows = Math.max(0, Math.floor(opts.scrollbackRows ?? 0))
    let acquisition = this.providerBufferAcquisitionsByPtyId.get(ptyId)
    if (acquisition?.generation === generation && acquisition.timedOut) {
      return null
    }
    if (
      !acquisition ||
      acquisition.generation !== generation ||
      acquisition.scrollbackRows < scrollbackRows
    ) {
      const promise = this.captureProviderTerminalBuffer(ptyId, opts, generation)
      acquisition = { generation, scrollbackRows, promise, timedOut: false }
      this.providerBufferAcquisitionsByPtyId.set(ptyId, acquisition)
      void promise.finally(() => {
        if (this.providerBufferAcquisitionsByPtyId.get(ptyId) === acquisition) {
          this.providerBufferAcquisitionsByPtyId.delete(ptyId)
        }
      })
    }
    if (typeof wait.timeoutMs !== 'number') {
      return acquisition.promise
    }
    // Undefined marks a timeout; null is a settled provider with no snapshot.
    const result = await withTimeout<PtyProviderBufferSnapshot | null | undefined>(
      acquisition.promise,
      wait.timeoutMs,
      undefined
    )
    if (result === undefined) {
      if (wait.retireOnTimeout) {
        acquisition.timedOut = true
      }
      return null
    }
    return result
  }
}
