import { describe, expect, it, vi } from 'vitest'
import { WRITE_ACCEPTED, type WriteSettlement } from '../../../shared/pty-write-settlement'
import { OrchestrationDb } from './db'
import { OrchestrationMailboxDeliveryTarget } from './mailbox-delivery-target'
import { OrchestrationMailboxOwner, type OrchestrationMailboxLeaf } from './mailbox-owner'
import { stageOrchestrationMailboxPointer } from './mailbox-pointer-stage'
import { OrchestrationMailboxPointerState } from './mailbox-pointer-state'

describe('a terminal pointer partially fetched before Enter', () => {
  it.each(
    ['before staging', 'during text write', 'before Enter', 'during liveness probe'].flatMap(
      (boundary) => [
        { boundary, ack: false, allFetched: false },
        { boundary, ack: true, allFetched: false },
        { boundary, ack: false, allFetched: true },
        { boundary, ack: true, allFetched: true }
      ]
    )
  )(
    'submits the unfetched tail when check runs $boundary (ack=$ack, all=$allFetched)',
    async ({ boundary, ack, allFetched }) => {
      vi.useFakeTimers()
      const db = new OrchestrationDb(':memory:')
      const state = new OrchestrationMailboxPointerState()
      const leaf: OrchestrationMailboxLeaf = {
        tabId: 'tab',
        leafId: 'leaf',
        ptyId: 'pty',
        writable: true,
        lastAgentStatus: 'idle',
        lastAgentStatusObservedLive: true,
        lastOscTitle: null
      }
      try {
        const run = db.createRun({
          objective: 'Partial fetch',
          coordinatorHandle: 'term',
          coordinatorPaneKey: 'tab:leaf'
        })
        const mailboxHandle = `run:${run.id}`
        const earlier = db.insertMessages(
          Array.from({ length: allFetched ? 48 : 49 }, (_, index) => ({
            runId: run.id,
            from: 'worker',
            to: mailboxHandle,
            subject: `Earlier ${index}`
          }))
        )
        db.markAsDelivered(earlier.map((message) => message.id))
        const messages = db.insertMessages(
          ['A', 'B'].map((subject) => ({
            runId: run.id,
            from: 'worker',
            to: mailboxHandle,
            subject
          }))
        )
        const tail = messages[1]!
        const checkAndAck = () => {
          const receipt = db.getOrCreateRunDelivery({
            runId: run.id,
            consumerGeneration: run.consumer_generation
          })
          expect(receipt?.messages).toHaveLength(50)
          expect(receipt?.messages.some((message) => message.id === tail.id)).toBe(allFetched)
          if (!receipt) {
            throw new Error('Missing consuming receipt')
          }
          if (ack) {
            db.acknowledgeRunDelivery({
              runId: run.id,
              consumerGeneration: run.consumer_generation,
              deliveryId: receipt.delivery.id
            })
          }
        }
        const mailboxOwner = new OrchestrationMailboxOwner({
          getDb: () => db,
          getLeaf: () => leaf,
          getLeafKey: () => 'tab:leaf',
          getTerminalHandleForLeafKey: () => 'term',
          getTerminalProcessIncarnation: () => 'inc',
          onRoutedMessageTypes: vi.fn(),
          onForeignMailboxRouted: vi.fn()
        })
        const deliveryTarget = new OrchestrationMailboxDeliveryTarget({
          getDb: () => db,
          getTerminalHandleForPaneKey: () => 'term',
          hasTerminalHandle: () => true,
          isStructuredSessionOwner: () => false,
          canProbePtyLiveness: () => false,
          controllerKnowsPtyIsLive: () => true,
          isLeafPtyProvenAbsent: async () => false
        })
        let settleText: ((settlement: WriteSettlement) => void) | undefined
        const writePty = vi.fn(
          (_ptyId: string, data: string): WriteSettlement | Promise<WriteSettlement> => {
            if (data !== '\r' && boundary === 'during text write') {
              return new Promise((resolve) => {
                settleText = resolve
              })
            }
            return WRITE_ACCEPTED
          }
        )
        if (boundary === 'before staging') {
          checkAndAck()
        }
        stageOrchestrationMailboxPointer({
          deps: {
            mailboxOwner,
            deliveryTarget,
            getDb: () => db,
            getLeaf: () => leaf,
            getLeafKey: () => 'tab:leaf',
            getLiveLeafForHandle: () => leaf,
            isAgentSettledForDelivery: () => true,
            getMessageWaiters: () => undefined,
            getTabTitle: () => null,
            getCliCommand: () => 'orca',
            getTerminalHandleForLeafKey: () => 'term',
            resolveSubmitTarget: () => ({
              leaf,
              terminalHandle: 'term',
              processIncarnation: 'inc'
            }),
            isLeafPtyProvenAbsent: async () => {
              if (boundary === 'during liveness probe') {
                checkAndAck()
              }
              return false
            },
            redriveMailbox: vi.fn(),
            writePty
          },
          state,
          leaf,
          mailboxHandle,
          messages,
          newestSequence: tail.sequence,
          enterDelayMs: 5,
          leafKey: 'tab:leaf',
          settle: (ptyId, flight) => state.settleFlight(ptyId, flight),
          redrive: vi.fn()
        })
        if (boundary === 'during text write' || boundary === 'before Enter') {
          checkAndAck()
        }
        settleText?.(WRITE_ACCEPTED)
        await vi.advanceTimersByTimeAsync(10)
        expect(writePty.mock.calls.filter(([, data]) => data === '\r')).toHaveLength(
          allFetched ? 0 : 1
        )
        expect(db.getMessageById(tail.id)).toMatchObject({
          read: allFetched && ack ? 1 : 0,
          pointer_enter_pending: 0
        })
        if (allFetched) {
          expect(db.getMessageById(tail.id)?.delivered_at).toBeNull()
        } else {
          expect(db.getMessageById(tail.id)?.delivered_at).not.toBeNull()
        }
        expect(state.hasFlight('pty')).toBe(false)
      } finally {
        state.retirePty('pty')
        db.close()
        vi.useRealTimers()
      }
    }
  )
})
