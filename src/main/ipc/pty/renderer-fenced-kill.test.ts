import { describe, expect, it, vi } from 'vitest'
import { DaemonPtyAdapter } from '../../daemon/daemon-pty-adapter'
import { waitFor } from '../../daemon/daemon-pty-adapter-test-harness'
import { startLateExitHarness } from './daemon-late-exit-test-fixture'
import { ptyIncarnationById } from './provider/ownership-state'
import { installPtyKillIpcHandler } from './ipc/renderer-kill'
import { shutdownProviderAndDetectExit } from './provider/shutdown-detect'

const request = (id: string, expectedIncarnationId: string) => ({
  id,
  expectedIncarnationId,
  requireNoAgentOwner: false,
  requireUnattached: false
})

describe('checked renderer stop route', () => {
  it('refuses missing identity without falling through to the unfenced stop', async () => {
    const harness = await startLateExitHarness()
    try {
      const markStop = vi.spyOn(harness.runtime, 'markPtyStopRequested')
      await expect(harness.killFenced({ id: harness.id })).resolves.toEqual({
        outcome: 'refused',
        reason: 'unsupported'
      })
      expect(harness.subprocess.forceKill).not.toHaveBeenCalled()
      expect(markStop).not.toHaveBeenCalled()
      expect(harness.rendererExits).toHaveLength(0)
      expect(harness.runtime.captureState().connected).toBe(true)
    } finally {
      await harness.dispose()
    }
  })

  it('leaves replacement ownership and runtime status untouched on refusal', async () => {
    const harness = await startLateExitHarness()
    try {
      const before = harness.runtime.captureState()
      const markStop = vi.spyOn(harness.runtime, 'markPtyStopRequested')
      await expect(harness.killFenced(request(harness.id, 'old-incarnation'))).resolves.toEqual({
        outcome: 'refused',
        reason: 'replaced'
      })
      expect(harness.runtime.captureState()).toEqual(before)
      expect(ptyIncarnationById.get(harness.id)).toBe(harness.result.incarnationId)
      expect(markStop).not.toHaveBeenCalled()
      expect(harness.rendererExits).toHaveLength(0)
    } finally {
      await harness.dispose()
    }
  })

  it('refuses old providers at dispatch, and retains ownership after a lost kill response', async () => {
    const harness = await startLateExitHarness()
    try {
      const supports = vi.spyOn(harness.adapter, 'supportsFencedTermination').mockReturnValue(false)
      await expect(
        harness.killFenced(request(harness.id, harness.result.incarnationId ?? 'missing'))
      ).resolves.toEqual({ outcome: 'refused', reason: 'unsupported' })
      supports.mockRestore()
      vi.spyOn(harness.adapter, 'killFenced').mockRejectedValue(new Error('response lost'))
      const markStop = vi.spyOn(harness.runtime, 'markPtyStopRequested')
      await expect(
        harness.killFenced(request(harness.id, harness.result.incarnationId ?? 'missing'))
      ).resolves.toEqual({ outcome: 'refused', reason: 'unverifiable' })
      expect(markStop).not.toHaveBeenCalled()
      expect(ptyIncarnationById.get(harness.id)).toBe(harness.result.incarnationId)
      expect(harness.rendererExits).toHaveLength(0)
    } finally {
      await harness.dispose()
    }
  })

  it('ends a tab-less terminal this run spawned, though main holds its stream', async () => {
    const harness = await startLateExitHarness()
    try {
      await expect(
        harness.killFenced({
          ...request(harness.id, harness.result.incarnationId ?? 'missing'),
          requireUnattached: true
        })
      ).resolves.toEqual({ outcome: 'ended' })
    } finally {
      await harness.dispose()
    }
  })

  it('keeps the daemon attached check when no runtime can answer for viewers', async () => {
    const harness = await startLateExitHarness()
    try {
      installPtyKillIpcHandler({
        getLocalPtyProviderStartupPromise: () => undefined,
        shutdownProviderAndDetectExit,
        rememberSyntheticKillExit: harness.session.rememberSyntheticKillExit,
        sendPtyExitToRenderer: harness.session.sendPtyExitToRenderer
      })
      await expect(
        harness.killFenced({
          ...request(harness.id, harness.result.incarnationId ?? 'missing'),
          requireUnattached: true
        })
      ).resolves.toEqual({ outcome: 'refused', reason: 'attached' })
    } finally {
      await harness.dispose()
    }
  })

  it('ends a tab-less restart survivor once main attaches it', async () => {
    const harness = await startLateExitHarness()
    const previousRun = new DaemonPtyAdapter({
      socketPath: harness.socketPath,
      tokenPath: harness.tokenPath
    })
    try {
      const survivorId = 'repo::/tmp/late-exit-audit@@survivor'
      const survivor = await previousRun.spawn({ cols: 80, rows: 24, sessionId: survivorId })
      const detached = vi.spyOn(harness.server['attachments'], 'detachClientSessions')
      await previousRun.disconnectOnly()
      await waitFor(() => detached.mock.calls.length > 0)
      await harness.adapter.attach(survivorId)
      await expect(
        harness.killFenced({
          ...request(survivorId, survivor.incarnationId ?? 'missing'),
          requireUnattached: true
        })
      ).resolves.toEqual({ outcome: 'ended' })
    } finally {
      await harness.dispose()
    }
  })

  it('refuses a tab-less end while a pane or remote view uses the terminal', async () => {
    const harness = await startLateExitHarness()
    try {
      const checked = {
        ...request(harness.id, harness.result.incarnationId ?? 'missing'),
        requireUnattached: true
      }
      const releaseRemote = harness.runtime.registerRemoteTerminalViewSubscriber(harness.id)
      await expect(harness.killFenced(checked)).resolves.toEqual({
        outcome: 'refused',
        reason: 'attached'
      })
      releaseRemote()
      harness.runtime.syncWindowGraph(1, {
        tabs: [
          {
            tabId: 'tab-1',
            worktreeId: 'repo::/tmp/late-exit-audit',
            title: '',
            activeLeafId: 'leaf-1',
            layout: null
          }
        ],
        leaves: [
          {
            tabId: 'tab-1',
            worktreeId: 'repo::/tmp/late-exit-audit',
            leafId: 'leaf-1',
            paneRuntimeId: 1,
            ptyId: harness.id,
            paneTitle: ''
          }
        ]
      })
      await expect(harness.killFenced(checked)).resolves.toEqual({
        outcome: 'refused',
        reason: 'attached'
      })
      expect(harness.subprocess.forceKill).not.toHaveBeenCalled()
    } finally {
      await harness.dispose()
    }
  })

  it('preserves operator-close provenance when the physical exit beats the control response', async () => {
    const harness = await startLateExitHarness()
    try {
      await expect(
        harness.killFenced(request(harness.id, harness.result.incarnationId ?? 'missing'))
      ).resolves.toEqual({ outcome: 'ended' })
      await harness.waitForExit()
      expect(harness.runtime.captureState().exitCause).toEqual({ kind: 'operator_close' })
    } finally {
      await harness.dispose()
    }
  })

  it('synthesizes an exit only for the proven incarnation when its control response beats the stream', async () => {
    const harness = await startLateExitHarness()
    try {
      harness.pauseStream()
      await expect(
        harness.killFenced(request(harness.id, harness.result.incarnationId ?? 'missing'))
      ).resolves.toEqual({ outcome: 'ended' })
      expect(harness.runtime.captureState().connected).toBe(false)
      expect(harness.rendererExits).toEqual([
        { id: harness.id, code: -1, incarnationId: harness.result.incarnationId }
      ])
      harness.resumeStream()
      await harness.waitForExit()
      expect(harness.rendererExits).toHaveLength(1)
    } finally {
      await harness.dispose()
    }
  })
})
