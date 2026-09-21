import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = await vi.hoisted(async () => {
  const { createSshIpcMocks } = await import('./ssh-ipc-module-mocks')
  return createSshIpcMocks()
})

vi.mock('../ssh/ssh-config-host-picker', () => mocks.sshConfigHostPicker)
vi.mock('electron', () => mocks.electron)
vi.mock('./ssh-pty-output-intake-registry', () => mocks.sshPtyOutputIntakeRegistry)
vi.mock('../ssh/ssh-connection-store', () => mocks.sshConnectionStore)
vi.mock('../ssh/ssh-connection-manager', () => mocks.sshConnectionManager)
vi.mock('../ssh/ssh-relay-deploy', () => mocks.sshRelayDeploy)
vi.mock('../ssh/ssh-relay-reset', () => mocks.sshRelayReset)
vi.mock('../ssh/ssh-channel-multiplexer', () => mocks.sshChannelMultiplexer)
vi.mock('../providers/ssh-pty-provider', () => mocks.sshPtyProvider)
vi.mock('../providers/ssh-filesystem-provider', () => mocks.sshFilesystemProvider)
vi.mock('./pty', () => mocks.pty)
vi.mock('../providers/ssh-filesystem-dispatch', () => mocks.sshFilesystemDispatch)
vi.mock('../providers/ssh-git-provider', () => mocks.sshGitProvider)
vi.mock('../providers/ssh-git-dispatch', () => mocks.sshGitDispatch)
vi.mock('../ssh/ssh-port-forward', () => mocks.sshPortForward)
vi.mock('../ssh/ssh-port-scanner', () => mocks.sshPortScanner)

import type { SshTarget } from '../../shared/ssh-types'
import { getSshPtyConsumerRecovery } from '../ssh/ssh-pty-consumer-recovery'
import { createSshIpcHarness } from './ssh-ipc-test-harness'

const { mockSshStore, mockConnectionManager, mockMux } = mocks

describe('SSH IPC handlers', () => {
  const harness = createSshIpcHarness(mocks)
  const { handlers, mockStore } = harness

  beforeEach(harness.reset)

  describe('SSH PTY consumer identity across failed connects', () => {
    function makeTarget(id: string): SshTarget {
      return { id, label: 'Server', host: 'example.com', port: 22, username: 'deploy' }
    }

    function markConnected(targetId: string): void {
      mockConnectionManager.getState.mockReturnValue({
        targetId,
        status: 'connected',
        error: null,
        reconnectAttempt: 0
      })
    }

    it('reclaims the consumer identity after a failed transport connect', async () => {
      const targetId = 'ssh-consumer-identity-connect-failure'
      let settleLeasePersistence!: () => void
      mockStore.markSshRemotePtyLeasesAsync.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            settleLeasePersistence = resolve
          })
      )
      mockSshStore.getTarget.mockReturnValue(makeTarget(targetId))
      mockConnectionManager.connect.mockRejectedValueOnce(new Error('transport refused'))

      const failedConnect = handlers.get('ssh:connect')!(null, { targetId }) as Promise<unknown>
      const failure = expect(failedConnect).rejects.toThrow('transport refused')
      const settled = vi.fn()
      void failedConnect.then(settled, settled)

      await vi.waitFor(() =>
        expect(mockStore.markSshRemotePtyLeasesAsync).toHaveBeenCalledWith(targetId, 'detached')
      )
      expect(mockStore.markSshRemotePtyLeases).not.toHaveBeenCalled()
      // Why: the connect rejection is gated on the durable 'detached' write, so the retry it
      // triggers cannot re-mark leases 'attached' ahead of the abandoned session's release.
      expect(settled).not.toHaveBeenCalled()

      settleLeasePersistence()
      await failure
      const claimedId = getSshPtyConsumerRecovery(targetId)?.clientInstanceId
      expect(claimedId).toEqual(expect.any(String))

      mockConnectionManager.connect.mockResolvedValue({})
      markConnected(targetId)
      await handlers.get('ssh:connect')!(null, { targetId })

      expect(getSshPtyConsumerRecovery(targetId)?.clientInstanceId).toBe(claimedId)
      expect(mockStore.upsertSshPtyConsumerRecovery).toHaveBeenCalledWith(
        expect.objectContaining({ targetId, clientInstanceId: claimedId })
      )
    })

    it('releases the abandoned leases before a fast reconnect re-owns them', async () => {
      const targetId = 'ssh-consumer-identity-fast-reconnect'
      const order: string[] = []
      let settleLeaseRelease!: () => void
      mockStore.markSshRemotePtyLeasesAsync.mockImplementationOnce((_id: string, state: string) => {
        order.push(`leases:${state}`)
        return new Promise<void>((resolve) => {
          settleLeaseRelease = () => {
            order.push(`leases:${state}:persisted`)
            resolve()
          }
        })
      })
      mockStore.upsertSshPtyConsumerRecovery.mockImplementation(async () => {
        order.push('recovery:upsert')
      })
      mockSshStore.getTarget.mockReturnValue(makeTarget(targetId))
      mockConnectionManager.connect.mockRejectedValueOnce(new Error('transport refused'))

      const failedConnect = handlers.get('ssh:connect')!(null, { targetId })
      const failure = expect(failedConnect).rejects.toThrow('transport refused')
      await vi.waitFor(() => expect(order).toContain('leases:detached'))
      expect(order).not.toContain('leases:detached:persisted')

      settleLeaseRelease()
      await failure

      mockConnectionManager.connect.mockResolvedValue({})
      markConnected(targetId)
      await handlers.get('ssh:connect')!(null, { targetId })

      // Why: the reclaimed owner is only re-persisted after the abandoned 'detached' write landed,
      // so no late release can strand the reconnected leases in 'detached'.
      expect(order).toEqual(['leases:detached', 'leases:detached:persisted', 'recovery:upsert'])
    })

    it('holds a retry that starts while the detach write is still pending', async () => {
      const targetId = 'ssh-consumer-identity-pending-retry'
      const order: string[] = []
      let settleLeaseRelease!: () => void
      mockStore.markSshRemotePtyLeasesAsync.mockImplementationOnce((_id: string, state: string) => {
        order.push(`leases:${state}`)
        return new Promise<void>((resolve) => {
          settleLeaseRelease = () => {
            order.push(`leases:${state}:persisted`)
            resolve()
          }
        })
      })
      mockStore.upsertSshPtyConsumerRecovery.mockImplementation(async () => {
        order.push('recovery:upsert')
      })
      mockSshStore.getTarget.mockReturnValue(makeTarget(targetId))
      mockConnectionManager.connect.mockRejectedValueOnce(new Error('transport refused'))

      const failedConnect = handlers.get('ssh:connect')!(null, { targetId })
      const failure = expect(failedConnect).rejects.toThrow('transport refused')
      await vi.waitFor(() => expect(order).toContain('leases:detached'))

      // Retry mid-write: it must not mint a session or re-own leases while the release is pending.
      mockConnectionManager.connect.mockResolvedValue({})
      markConnected(targetId)
      const retry = handlers.get('ssh:connect')!(null, { targetId }) as Promise<unknown>
      const retrySettled = vi.fn()
      void retry.then(retrySettled, retrySettled)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(retrySettled).not.toHaveBeenCalled()
      expect(order).not.toContain('leases:detached:persisted')

      settleLeaseRelease()
      await failure
      // Why: the retry folds onto the still-latched attempt rather than starting a second connect,
      // so it inherits that attempt's failure instead of racing its teardown.
      await expect(retry).rejects.toThrow('transport refused')
      expect(mockConnectionManager.connect).toHaveBeenCalledTimes(1)
      expect(order).toEqual(['leases:detached', 'leases:detached:persisted'])

      await handlers.get('ssh:connect')!(null, { targetId })

      expect(order).toEqual(['leases:detached', 'leases:detached:persisted', 'recovery:upsert'])
    })

    it('replaces a live session whose detach write keeps failing', async () => {
      const targetId = 'ssh-consumer-identity-detach-write-failure'
      mockSshStore.getTarget.mockReturnValue(makeTarget(targetId))
      mockConnectionManager.connect.mockResolvedValue({})
      markConnected(targetId)
      await handlers.get('ssh:connect')!(null, { targetId })
      const claimedId = getSshPtyConsumerRecovery(targetId)?.clientInstanceId
      expect(claimedId).toEqual(expect.any(String))

      // Why a permanent reject, not once: it proves the failed session is gone rather than merely
      // retried — a second connect that still holds it would fail on the same write again.
      mockStore.markSshRemotePtyLeasesAsync.mockImplementation((_id: string, state: string) =>
        state === 'detached'
          ? Promise.reject(new Error('lease write failed'))
          : Promise.resolve(undefined)
      )
      await expect(handlers.get('ssh:connect')!(null, { targetId })).rejects.toThrow(
        'lease write failed'
      )

      mockConnectionManager.connect.mockClear()
      await handlers.get('ssh:connect')!(null, { targetId })

      expect(mockConnectionManager.connect).toHaveBeenCalledTimes(1)
      // Why: the abandoned session still released its identity synchronously, so the replacement
      // reclaims the owner instead of minting a new one.
      expect(getSshPtyConsumerRecovery(targetId)?.clientInstanceId).toBe(claimedId)
    })

    it('resumes the remembered owner lease after a failed establish', async () => {
      const targetId = 'ssh-consumer-identity-establish-failure'
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      mockSshStore.getTarget.mockReturnValue(makeTarget(targetId))
      mockConnectionManager.connect.mockResolvedValue({})
      markConnected(targetId)
      // Why: fail the first request after the consumer session opens, so establish() rejects with an
      // owner lease already remembered — the state a retry must be able to resume from.
      const openClientResponse = await mockMux.request('pty.openClient')
      mockMux.request.mockImplementationOnce(() => Promise.resolve(openClientResponse))
      mockMux.request.mockImplementationOnce(() =>
        Promise.reject(new Error('relay handshake aborted'))
      )
      mockStore.markSshRemotePtyLeasesAsync.mockRejectedValueOnce(
        new Error('lease persistence failed')
      )

      try {
        await expect(handlers.get('ssh:connect')!(null, { targetId })).rejects.toThrow(
          'relay handshake aborted'
        )
        await vi.waitFor(() => expect(warn).toHaveBeenCalled())
        const claimedId = getSshPtyConsumerRecovery(targetId)?.clientInstanceId
        expect(claimedId).toEqual(expect.any(String))

        mockMux.request.mockClear()
        await handlers.get('ssh:connect')!(null, { targetId })

        expect(getSshPtyConsumerRecovery(targetId)?.clientInstanceId).toBe(claimedId)
        expect(mockMux.request).toHaveBeenCalledWith(
          'pty.openClient',
          expect.objectContaining({
            clientInstanceId: claimedId,
            resume: { ownerGeneration: 1, ownerLease: 'ipc-test-owner' }
          }),
          expect.anything()
        )
      } finally {
        warn.mockRestore()
      }
    })
  })
})
