/**
 * A PTY that exits without a resolvable spawn-time pane key never reaches
 * `agentHookServer.clearPaneState`, so its row and every Claude latch outlive the process with
 * nothing left to retire them (STA-4612). `onPtyExit` knows the pane keys that teardown could not
 * resolve, so it reconciles them — but only on a real death certificate.
 */
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { makePaneKey } from '../../shared/stable-pane-id'

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
  const runtime = new OrcaRuntimeService(null, undefined, {
    reconcileAgentStatusForEndedProcess: reconcile
  })
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
    // node-pty forwards real exits as -1 (local-pty-provider-shutdown.test.ts pins this), so the
    // numeric code alone cannot separate a dead process from a failed stop.
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
    // A WSL pane carries a `wsl:*` connectionId, so a negative exit keeps the abnormal-SSH surface
    // (liveness unverifiable, launch authority not retired) — but the daemon provider's own exit
    // callback still witnessed the process die. The two decisions are deliberately independent;
    // without this the connectionId arm of the certificate is never exercised.
    const reconcile = vi.fn()
    runtimeWithBoundPane(reconcile, { connectionId: 'wsl:Ubuntu' }).onPtyExit(PTY, -1, undefined, {
      providerExitObserved: true
    })

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
