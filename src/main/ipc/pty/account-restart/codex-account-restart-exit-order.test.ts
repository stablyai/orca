import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { PtyFencedTerminationOutcome } from '../../../../shared/terminal/pty/lifecycle/pty-fenced-termination'

type ExitPayload = {
  id: string
  code: number
  incarnationId?: string
  hostLost?: true
  replacedByRestart?: true
}

type HoistedState = {
  handlers: Map<string, (event: unknown, args: unknown) => unknown>
  exitListener: ((payload: ExitPayload) => void) | null
  killFenced: Mock<(...args: unknown[]) => Promise<PtyFencedTerminationOutcome>>
  fencedTerminationSupported: boolean
  selectedAccount: string
  providerStartup: Promise<void> | undefined
}

const h = vi.hoisted((): HoistedState => ({
  handlers: new Map(),
  exitListener: null,
  killFenced: vi.fn<(...args: unknown[]) => Promise<PtyFencedTerminationOutcome>>(),
  fencedTerminationSupported: true,
  selectedAccount: 'new',
  providerStartup: undefined
}))

vi.mock('../pty-host-bindings', () => ({
  getPtyIpc: () => ({
    handle: (channel: string, fn: (event: unknown, args: unknown) => unknown) =>
      h.handlers.set(channel, fn)
  })
}))
vi.mock('../provider/registry', () => ({
  localProvider: {
    onExit: (cb: (payload: ExitPayload) => void) => {
      h.exitListener = cb
      return () => {}
    },
    onData: () => () => {}
  },
  resolvePtyExecutionHost: () => 'local',
  tryGetProviderForPty: () => ({
    killFenced: (...args: unknown[]) => h.killFenced(...args),
    supportsFencedTermination: () => h.fencedTerminationSupported
  })
}))
vi.mock('../provider/state-cleanup', async () => {
  const { ptyIncarnationById } = await import('../provider/ownership-state')
  return { clearProviderPtyState: (id: string) => ptyIncarnationById.delete(id) }
})
vi.mock('../provider/liveness', async () => {
  const { ptyIncarnationById } = await import('../provider/ownership-state')
  return { finishPtyShutdown: (id: string) => ptyIncarnationById.delete(id) }
})
vi.mock('../delivery/visibility-state', () => ({
  SYNTHETIC_KILL_EXIT_DUPLICATE_WINDOW_MS: 30_000,
  providerSnapshotRequiredPtys: new Set(),
  visibleRendererPtys: new Set()
}))
vi.mock('../delivery/pty-escape-boundary', () => ({ markPtyEscapeBoundaryUnknown: () => {} }))
vi.mock('../delivery/accept', () => ({ discardPendingPtyDataAcrossGap: () => {} }))
vi.mock('../../../runtime/terminal/pty-endpoint-loss-signal', () => ({
  publishPtyEndpointLoss: () => {}
}))
vi.mock('../../../agent-hooks/wsl-relay/wsl-bridge-pty-presence', () => ({
  wslBridgePtyPresence: { noteExited: () => {} }
}))
vi.mock('../pane/stable-owner', () => ({
  resolvePersistedStablePaneOwner: (_store: unknown, paneKey: string) => {
    const owner = currentOwnerByPaneKey.get(paneKey)
    return owner ? { tabId: 'tab', leafId: 'leaf', ...owner } : null
  }
}))
vi.mock('../../../agent-hooks/server/agent-hook-server', () => ({
  agentHookServer: {
    getStatusSnapshotForPane: () => [
      {
        agentType: 'codex',
        providerSession: {
          key: 'session_id',
          id: 'thread-1',
          transcriptPath: '/old/sessions/2026/11/01/rollout-thread-1.jsonl'
        }
      }
    ]
  }
}))
vi.mock('../../../codex/configuration/homes/codex-pane-account-registry', () => ({
  peekLoadedCodexPaneAccount: () => ({
    selectionKey: 'host',
    accountId: 'old',
    homeRoute: 'account-home'
  })
}))
vi.mock('../../../codex-accounts/account-management/runtime-selection', () => ({
  getSelectedCodexAccountIdForTarget: () => h.selectedAccount
}))
vi.mock('../../../pty/process-retirement/pty-exit-proof', () => ({
  PtyExitProof: { from: () => ({}) }
}))

const currentOwnerByPaneKey = new Map<string, { ptyId: string; incarnationId: string }>()

import { bindProviderListeners } from '../provider/bind-listeners'
import { ptyIncarnationById } from '../provider/ownership-state'
import { TerminalIntentionalStops } from '../../../runtime/terminal/stop/terminal-intentional-stops'
import { installCodexAccountRestartIpcHandlers } from './codex-account-restart-ipc'
import { codexAccountRestartStops } from './codex-account-restart-stops'
import { releaseAbsentPaneOwner } from '../pane/absent-pane-owner'
import type { PtyIpcSession } from '../session'

let paneCounter = 0
function nextPane(): { leafId: string; ptyId: string; incarnationId: string } {
  paneCounter += 1
  const suffix = String(paneCounter).padStart(12, '0')
  return {
    leafId: `00000000-0000-4000-8000-${suffix}`,
    ptyId: `pty-${paneCounter}`,
    incarnationId: `inc-${paneCounter}`
  }
}

function setup() {
  const runtime = {
    intentionalPtyStops: new TerminalIntentionalStops(),
    onPtyExit: vi.fn(),
    markPtyStopRequested: vi.fn()
  }
  const sendPtyExitToRenderer = vi.fn()
  const sessionFields = {
    runtime,
    consumeSyntheticKillExit: () => false,
    sendPtyExitToRenderer,
    acceptPtyDataForRenderer: () => {}
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the listener reads only these fields.
  const session = sessionFields as unknown as PtyIpcSession
  bindProviderListeners(session)
  installCodexAccountRestartIpcHandlers({
    store: undefined,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the restart path reads only these runtime fields.
    runtime: runtime as never,
    getLocalPtyProviderStartupPromise: () => h.providerStartup,
    shutdownProviderAndDetectExit: vi.fn(),
    rememberSyntheticKillExit: vi.fn(),
    sendPtyExitToRenderer,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: staleness is mocked.
    getSettings: () => ({}) as never
  })
  const pane = nextPane()
  currentOwnerByPaneKey.set(`tab:${pane.leafId}`, {
    ptyId: pane.ptyId,
    incarnationId: pane.incarnationId
  })
  ptyIncarnationById.set(pane.ptyId, pane.incarnationId)
  let releaseStop!: (outcome: PtyFencedTerminationOutcome) => void
  h.killFenced = vi.fn(
    () =>
      new Promise<PtyFencedTerminationOutcome>((resolve) => {
        releaseStop = resolve
      })
  )
  const request = async (): Promise<unknown> =>
    await h.handlers.get('pty:stopCodexForAccountRestart')!(null, {
      worktreeId: 'wt',
      tabId: 'tab',
      leafId: pane.leafId,
      ptyId: pane.ptyId,
      opId: `op-${pane.ptyId}`
    })
  const emitExit = (payload: Partial<ExitPayload> = {}) =>
    h.exitListener!({ id: pane.ptyId, code: 0, incarnationId: pane.incarnationId, ...payload })
  const stopDispatched = async () => {
    await vi.waitFor(() => expect(h.killFenced).toHaveBeenCalledTimes(1))
  }
  return {
    pane,
    runtime,
    sendPtyExitToRenderer,
    request,
    emitExit,
    stopDispatched,
    release: (o: PtyFencedTerminationOutcome) => releaseStop(o)
  }
}

describe('account restart exits arriving out of order', () => {
  beforeEach(() => {
    h.handlers.clear()
    h.fencedTerminationSupported = true
    h.selectedAccount = 'new'
    h.providerStartup = undefined
  })

  it('delivers one restart exit when the stream exit beats the stop receipt', async () => {
    const t = setup()
    const result = t.request()
    await t.stopDispatched()
    t.emitExit()
    expect(t.runtime.onPtyExit).toHaveBeenCalledTimes(1)
    expect(t.runtime.onPtyExit.mock.calls[0][3]).toMatchObject({ paneRespawning: true })
    expect(t.sendPtyExitToRenderer).toHaveBeenCalledTimes(1)
    t.release({ outcome: 'ended', writersExited: true })
    await expect(result).resolves.toMatchObject({ outcome: 'stopped' })
    // A late duplicate is dropped without any time window.
    t.emitExit()
    expect(t.runtime.onPtyExit).toHaveBeenCalledTimes(1)
    expect(t.sendPtyExitToRenderer).toHaveBeenCalledTimes(1)
  })

  it('delivers one restart exit when the stop receipt beats the stream exit', async () => {
    const t = setup()
    const result = t.request()
    await t.stopDispatched()
    t.release({ outcome: 'ended', writersExited: true })
    await expect(result).resolves.toMatchObject({ outcome: 'stopped' })
    expect(t.runtime.onPtyExit).toHaveBeenCalledTimes(1)
    expect(t.runtime.onPtyExit.mock.calls[0][3]).toMatchObject({
      paneRespawning: true,
      hostExitConfirmed: true
    })
    expect(t.sendPtyExitToRenderer).toHaveBeenCalledTimes(1)
    t.emitExit()
    expect(t.runtime.onPtyExit).toHaveBeenCalledTimes(1)
    expect(t.sendPtyExitToRenderer).toHaveBeenCalledTimes(1)
  })

  it('labels the delivered exit as a pane-keeping restart for every consumer', async () => {
    const t = setup()
    const result = t.request()
    await t.stopDispatched()
    const claimed: string[][] = []
    t.sendPtyExitToRenderer.mockImplementation(({ id, incarnationId }) =>
      claimed.push([...t.runtime.intentionalPtyStops.claimExit(id, incarnationId)])
    )
    t.emitExit()
    expect(claimed).toEqual([['replaced']])
    t.release({ outcome: 'ended', writersExited: true })
    await result
  })

  it('keeps a host-loss exit as the logical exit but never as writer proof', async () => {
    const t = setup()
    const result = t.request()
    await t.stopDispatched()
    t.emitExit({ hostLost: true })
    t.release({ outcome: 'refused', reason: 'unverifiable' })
    await expect(result).resolves.toMatchObject({ outcome: 'unknown' })
    expect(t.runtime.onPtyExit).toHaveBeenCalledTimes(1)
    const decision = await codexAccountRestartStops.resolveResume({
      paneKey: `wt\0tab\0${t.pane.leafId}`,
      providerSession: { key: 'session_id', id: 'thread-1' }
    })
    expect(decision.kind).toBe('pinned')
  })

  it('still delivers an ordinary exit of another incarnation after the pane rebinds', async () => {
    const t = setup()
    const result = t.request()
    await t.stopDispatched()
    t.release({ outcome: 'ended', writersExited: true })
    await result
    codexAccountRestartStops.forgetPane(`wt\0tab\0${t.pane.leafId}`)
    // The stopped incarnation's late exit stays dropped after its intent is gone.
    t.emitExit()
    expect(t.sendPtyExitToRenderer).toHaveBeenCalledTimes(1)
    // A new process in the same pane exits normally.
    t.emitExit({ incarnationId: 'inc-successor' })
    expect(t.sendPtyExitToRenderer).toHaveBeenCalledTimes(2)
    expect(t.runtime.onPtyExit.mock.calls[1][3]).not.toHaveProperty('paneRespawning')
  })

  it('refuses an older terminal service without stopping anything, never falling back', async () => {
    const t = setup()
    h.fencedTerminationSupported = false
    await expect(t.request()).resolves.toMatchObject({
      outcome: 'not-started',
      reason: 'service-outdated'
    })
    expect(h.killFenced).not.toHaveBeenCalled()
  })

  it('maps an unsupported fenced refusal to the same manual refusal and classifies no exit', async () => {
    const t = setup()
    const result = t.request()
    await t.stopDispatched()
    t.release({ outcome: 'refused', reason: 'unsupported' })
    await expect(result).resolves.toMatchObject({
      outcome: 'not-started',
      reason: 'service-outdated'
    })
    t.emitExit()
    expect(t.runtime.onPtyExit.mock.calls[0][3]).not.toHaveProperty('paneRespawning')
  })

  it('keeps the pane but resumes on the old account when descendants were not verified gone', async () => {
    const t = setup()
    const result = t.request()
    await t.stopDispatched()
    t.release({ outcome: 'ended' })
    await expect(result).resolves.toMatchObject({ outcome: 'unknown' })
    expect(t.runtime.onPtyExit).toHaveBeenCalledTimes(1)
    expect(t.runtime.onPtyExit.mock.calls[0][3]).toMatchObject({ paneRespawning: true })
    const decision = await codexAccountRestartStops.resolveResume({
      paneKey: `wt\0tab\0${t.pane.leafId}`,
      providerSession: { key: 'session_id', id: 'thread-1' }
    })
    expect(decision.kind).toBe('pinned')
  })

  it('delivers a receipt to the window registered now, not the one that asked', async () => {
    const t = setup()
    const result = t.request()
    await t.stopDispatched()
    // macOS window reactivation re-registers PTY IPC while the stop is held.
    const nextWindowSend = vi.fn()
    installCodexAccountRestartIpcHandlers({
      store: undefined,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the restart path reads only these runtime fields.
      runtime: t.runtime as never,
      getLocalPtyProviderStartupPromise: () => h.providerStartup,
      shutdownProviderAndDetectExit: vi.fn(),
      rememberSyntheticKillExit: vi.fn(),
      sendPtyExitToRenderer: nextWindowSend,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: staleness is mocked.
      getSettings: () => ({}) as never
    })
    t.release({ outcome: 'ended', writersExited: true })
    await result
    expect(nextWindowSend).toHaveBeenCalledTimes(1)
    expect(t.sendPtyExitToRenderer).not.toHaveBeenCalled()
  })

  it('does not end the process a second time when an attach miss follows the receipt', async () => {
    const t = setup()
    const result = t.request()
    await t.stopDispatched()
    t.release({ outcome: 'ended', writersExited: true })
    await result
    expect(t.runtime.onPtyExit).toHaveBeenCalledTimes(1)
    await releaseAbsentPaneOwner(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the release reads only these runtime fields.
      { runtime: t.runtime as never },
      {
        tabId: 'tab',
        leafId: t.pane.leafId,
        ptyId: t.pane.ptyId,
        incarnationId: t.pane.incarnationId,
        runtimeIncarnationId: t.pane.incarnationId
      }
    )
    expect(t.runtime.onPtyExit).toHaveBeenCalledTimes(1)
  })

  it('sends no stop when Dismiss lands while main waits for the terminal service', async () => {
    const t = setup()
    let releaseStartup!: () => void
    h.providerStartup = new Promise<void>((resolve) => {
      releaseStartup = resolve
    })
    const result = t.request()
    await vi.waitFor(() =>
      expect(
        codexAccountRestartStops.withdraw({
          worktreeId: 'wt',
          tabId: 'tab',
          leafId: t.pane.leafId,
          opId: `op-${t.pane.ptyId}`
        })
      ).toBe(true)
    )
    releaseStartup()
    await expect(result).resolves.toMatchObject({ outcome: 'not-started', reason: 'withdrawn' })
    expect(h.killFenced).not.toHaveBeenCalled()
  })

  it('sends no stop when the user selects the old account again during that wait', async () => {
    const t = setup()
    let releaseStartup!: () => void
    h.providerStartup = new Promise<void>((resolve) => {
      releaseStartup = resolve
    })
    const result = t.request()
    await Promise.resolve()
    await Promise.resolve()
    h.selectedAccount = 'old'
    releaseStartup()
    await expect(result).resolves.toMatchObject({ outcome: 'not-started', reason: 'not-stale' })
    expect(h.killFenced).not.toHaveBeenCalled()
  })

  it('still gives the renderer its exit when an attach miss told runtime first', async () => {
    const t = setup()
    const result = t.request()
    await t.stopDispatched()
    await releaseAbsentPaneOwner(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the release reads only these runtime fields.
      { runtime: t.runtime as never },
      {
        tabId: 'tab',
        leafId: t.pane.leafId,
        ptyId: t.pane.ptyId,
        incarnationId: t.pane.incarnationId,
        runtimeIncarnationId: t.pane.incarnationId
      }
    )
    expect(t.runtime.onPtyExit).toHaveBeenCalledTimes(1)
    expect(t.sendPtyExitToRenderer).not.toHaveBeenCalled()
    t.emitExit()
    t.release({ outcome: 'ended', writersExited: true })
    await result
    expect(t.runtime.onPtyExit).toHaveBeenCalledTimes(1)
    expect(t.sendPtyExitToRenderer).toHaveBeenCalledTimes(1)
  })

  it('writes no kill when the grant is revoked during the daemon connection wait', async () => {
    const t = setup()
    let releaseConnection!: () => void
    const connected = new Promise<void>((resolve) => {
      releaseConnection = resolve
    })
    let killsWritten = 0
    h.killFenced = vi.fn(async (...args: unknown[]) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the restart IPC passes its local options second.
      const options = args[1] as { beforeRequest?: () => boolean } | undefined
      await connected
      if (options?.beforeRequest?.() === false) {
        return { outcome: 'refused', reason: 'unverifiable' } as const
      }
      killsWritten += 1
      return { outcome: 'ended', writersExited: true } as const
    })
    const result = t.request()
    await vi.waitFor(() => expect(h.killFenced).toHaveBeenCalledTimes(1))
    h.selectedAccount = 'old'
    releaseConnection()
    await expect(result).resolves.toMatchObject({ outcome: 'not-started', reason: 'not-stale' })
    expect(killsWritten).toBe(0)
  })
})
