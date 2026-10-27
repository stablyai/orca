/** Reconcile orphaned hook rows on observed PTY death when spawn-time pane lookup cannot clear them (STA-4612). */
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { makePaneKey } from '../../shared/stable-pane-id'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'
import { bindPaneFirst } from './bind-first-pane.test-fixture'

export function registerPtyExitAgentStatusReconciliationTests(): void {
  const LEAF = '11111111-1111-4111-8111-111111111111'
  const PANE = makePaneKey('tab-1', LEAF)
  const PTY = 'wt-1__pty-1'

  type RuntimeInternals = {
    ptysById: Map<string, { ptyId: string; paneKey: string; worktreeId: string; tabId: string }>
  }

  function runtimeWithBoundPane(
    reconcile: (paneKeys: Iterable<string>) => void,
    options: { connectionId?: string } = {}
  ): OrcaRuntimeService {
    // Main-owned bindings require a session-backed fixture store.
    const runtime = new OrcaRuntimeService(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: bindPaneFirst fills in the session accessors main's layout reads.
      ORCA_LAYOUT_OWNER_IS_MAIN ? ({} as never) : null,
      undefined,
      {
        reconcileAgentStatusForEndedProcess: reconcile
      }
    )
    bindPaneFirst(runtime, { worktreeId: 'wt-1', tabId: 'tab-1', leafId: LEAF, ptyId: PTY })
    const ptys = (runtime as unknown as RuntimeInternals).ptysById
    ptys.set(PTY, {
      ptyId: PTY,
      paneKey: PANE,
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      ...(options.connectionId ? { connectionId: options.connectionId } : {})
    } as never)
    return runtime
  }

  function reconciledPaneKeys(calls: Iterable<string>[]): string[] {
    return calls.flatMap((keys) => [...keys])
  }

  describe('onPtyExit agent-status reconciliation', () => {
    it('reconciles on a normal zero exit code', () => {
      const reconcile = vi.fn()
      runtimeWithBoundPane(reconcile).onPtyExit(PTY, 0)

      expect(reconciledPaneKeys(reconcile.mock.calls.map(([keys]) => keys))).toContain(PANE)
    })

    it('reconciles a physical -1 exit reported by the provider callback', () => {
      // node-pty reports real exits as -1 too; numeric code alone cannot attest process death.
      const reconcile = vi.fn()
      runtimeWithBoundPane(reconcile).onPtyExit(PTY, -1, undefined, { providerExitObserved: true })

      expect(reconciledPaneKeys(reconcile.mock.calls.map(([keys]) => keys))).toContain(PANE)
    })

    it('reconciles a host-confirmed negative exit', () => {
      const reconcile = vi.fn()
      runtimeWithBoundPane(reconcile).onPtyExit(PTY, -1, undefined, { hostExitConfirmed: true })

      expect(reconciledPaneKeys(reconcile.mock.calls.map(([keys]) => keys))).toContain(PANE)
    })

    it('reconciles a provider-observed -1 on a pane bound to a transport, where the SSH surface is preserved', () => {
      // WSL's connection id can retain an abnormal surface while a provider exit independently certifies process death.
      const reconcile = vi.fn()
      runtimeWithBoundPane(reconcile, { connectionId: 'wsl:Ubuntu' }).onPtyExit(
        PTY,
        -1,
        undefined,
        {
          providerExitObserved: true
        }
      )

      expect(reconciledPaneKeys(reconcile.mock.calls.map(([keys]) => keys))).toContain(PANE)
    })

    it('does NOT reconcile a transport-bound synthetic -1, whose remote PTY is designed to survive it', () => {
      const reconcile = vi.fn()
      runtimeWithBoundPane(reconcile, { connectionId: 'ssh-conn-1' }).onPtyExit(PTY, -1)

      expect(reconcile).not.toHaveBeenCalled()
    })

    it('does NOT reconcile a synthetic -1 from a failed stop, whose PTY may have survived', () => {
      const reconcile = vi.fn()
      runtimeWithBoundPane(reconcile).onPtyExit(PTY, -1)

      expect(reconcile).not.toHaveBeenCalled()
    })
  })
}
