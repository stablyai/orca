import { describe, expect, it, vi } from 'vitest'
import { toAppSshPtyId } from '../../../../shared/ssh-pty-id'
import type { PtyRuntimeControllerDeps } from './controller-deps'
import { PtyExitProof } from '../../../pty-exit-proof'

const bridge = vi.hoisted((): { proven: 'gone' | 'reported' | null } => ({ proven: 'gone' }))

vi.mock('../../../ssh/legacy-relay/legacy-relay-bridge-registry', () => ({
  closeLegacyRelayPane: vi.fn(),
  isLegacyRelayBridgedPty: () => true,
  stopLegacyRelayPaneAndWait: async () => bridge.proven
}))

const { stopAndWaitPtyFromRuntimeController } = await import('./kill')

describe('a proven stop-and-wait of a terminal an older relay still runs', () => {
  it('tells the runtime the terminal exited, without tombstoning the lease the bridge retired', async () => {
    for (const proven of ['gone', 'reported', null] as const) {
      bridge.proven = proven
      const deps = {
        runtime: { markPtyStopRequested: vi.fn(), onPtyExit: vi.fn() },
        store: null,
        getLocalPtyProviderStartupPromise: () => null,
        shutdownProviderAndDetectExit: vi.fn(),
        finishPtyShutdown: vi.fn(() => undefined),
        rememberSyntheticKillExit: vi.fn(),
        sendPtyExitToRenderer: vi.fn()
      }
      const ptyId = toAppSshPtyId('ssh-box', 'pty2:epoch:1')
      await expect(
        stopAndWaitPtyFromRuntimeController(
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the bridged branch reads only these deps.
          deps as unknown as PtyRuntimeControllerDeps,
          ptyId,
          { deadlineMs: Date.now() + 1_000 }
        )
      ).resolves.toBe(proven !== null)
      if (proven) {
        expect(deps.finishPtyShutdown).toHaveBeenCalledWith(
          ptyId,
          null,
          null,
          PtyExitProof.from('absent', undefined)
        )
        // A reported exit already reached the runtime through the bridge.
        if (proven === 'gone') {
          expect(deps.runtime.onPtyExit).toHaveBeenCalledWith(ptyId, 0, undefined)
        } else {
          expect(deps.runtime.onPtyExit).not.toHaveBeenCalled()
        }
        expect(deps.sendPtyExitToRenderer).toHaveBeenCalledWith({ id: ptyId, code: 0 })
      } else {
        expect(deps.finishPtyShutdown).not.toHaveBeenCalled()
        expect(deps.runtime.onPtyExit).not.toHaveBeenCalled()
      }
    }
  })
})
