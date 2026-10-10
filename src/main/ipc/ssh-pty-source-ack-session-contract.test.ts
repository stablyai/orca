import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PtySourceCreditAckBatch } from '../../shared/pty-source-credit-contract'
import { SshPtyOutputIntake } from './ssh-pty-output-intake'
import {
  installSshPtySourceAckPublisher,
  publishSshPtySourceAck
} from './ssh-pty-output-intake-registry'

afterEach(() => vi.useRealTimers())

describe('SSH PTY intake to relay ACK contract', () => {
  it('publishes one cumulative relay-ID ACK only after model and desktop settlement', async () => {
    vi.useFakeTimers()
    const batches: PtySourceCreditAckBatch[] = []
    const cleanup = installSshPtySourceAckPublisher(7, (batch, onSettled) => {
      batches.push(batch)
      onSettled({ ok: true })
    })
    let sequence = 0
    const intake = new SshPtyOutputIntake({
      getModelSequence: () => sequence,
      acceptModel: (event) => {
        sequence += event.rawLength
        return { sequence, completion: Promise.resolve() }
      },
      project: () => {},
      prepareExit: () => {},
      finalizeExit: () => {},
      publishSourceAck: publishSshPtySourceAck
    })

    try {
      const receipt = await intake.acceptData({
        id: 'ssh:target@@relay-pty-1',
        data: 'data',
        providerGeneration: 7,
        ptyIncarnation: 'incarnation-1',
        rawLength: 4,
        transformed: false,
        source: {
          relayPtyId: 'relay-pty-1',
          spanId: 'token-1:0:4',
          clientGeneration: 2,
          ownerGeneration: 3,
          deliveryToken: 'token-1',
          sourceStartSu: 0,
          sourceEndSu: 4
        }
      })
      await vi.advanceTimersByTimeAsync(8)
      expect(batches).toHaveLength(0)

      const projectionId = receipt.projection.identity.projectionSemanticsId
      intake.publishProjectionPrefix([projectionId], 4, 4)
      intake.settleProjectionPrefix('ssh:target@@relay-pty-1', 4)
      await vi.advanceTimersByTimeAsync(8)

      expect(batches).toEqual([
        {
          acknowledgements: [
            {
              id: 'relay-pty-1',
              clientGeneration: 2,
              ownerGeneration: 3,
              deliveryToken: 'token-1',
              creditedEndSu: 4
            }
          ]
        }
      ])
      await intake.acceptExit({
        id: 'ssh:target@@relay-pty-1',
        code: 0,
        providerGeneration: 7,
        ptyIncarnation: 'incarnation-1'
      })
      expect(intake.getDebugSnapshot().source).toEqual({
        openedTokens: 0,
        ptyIdentities: 0
      })
    } finally {
      intake.dispose()
      cleanup()
    }
  })

  it('withholds source credit until the main terminal model finishes the chunk', async () => {
    vi.useFakeTimers()
    const batches: PtySourceCreditAckBatch[] = []
    const cleanup = installSshPtySourceAckPublisher(8, (batch, onSettled) => {
      batches.push(batch)
      onSettled({ ok: true })
    })
    let finishModel: () => void = () => {}
    const projectionIds: string[] = []
    let sequence = 0
    const intake = new SshPtyOutputIntake({
      getModelSequence: () => sequence,
      acceptModel: (event) => {
        sequence += event.rawLength
        return {
          sequence,
          completion: new Promise<void>((resolve) => {
            finishModel = resolve
          })
        }
      },
      project: (_event, projection) => {
        projectionIds.push(projection.identity.projectionSemanticsId)
      },
      prepareExit: () => {},
      finalizeExit: () => {},
      publishSourceAck: publishSshPtySourceAck
    })

    try {
      const receipt = intake.acceptData({
        id: 'ssh:target@@relay-pty-2',
        data: 'frame',
        providerGeneration: 8,
        ptyIncarnation: 'incarnation-2',
        rawLength: 5,
        transformed: false,
        source: {
          relayPtyId: 'relay-pty-2',
          spanId: 'token-2:0:5',
          clientGeneration: 2,
          ownerGeneration: 3,
          deliveryToken: 'token-2',
          sourceStartSu: 0,
          sourceEndSu: 5
        }
      })
      // The renderer drains its copy first; a slow main model must still hold the remote credit.
      intake.publishProjectionPrefix(projectionIds, 5, 5)
      intake.settleProjectionPrefix('ssh:target@@relay-pty-2', 5)
      await vi.advanceTimersByTimeAsync(8)
      expect(batches).toHaveLength(0)

      finishModel()
      await receipt
      await vi.advanceTimersByTimeAsync(8)
      expect(batches).toEqual([
        {
          acknowledgements: [
            {
              id: 'relay-pty-2',
              clientGeneration: 2,
              ownerGeneration: 3,
              deliveryToken: 'token-2',
              creditedEndSu: 5
            }
          ]
        }
      ])
    } finally {
      intake.dispose()
      cleanup()
    }
  })
})
