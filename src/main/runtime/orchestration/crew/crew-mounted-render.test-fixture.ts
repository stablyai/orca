import { vi } from 'vitest'
import { CrewReadModel } from './crew-read-model'
import { fixture } from './crew-read-model.test-fixture'
import { subscribeCrew } from './crew-stream'
import { agentSessionRecordFixture } from '../../../native-chat/agent-session-record-test-fixture'
import { agentSessionConversationView } from '../../../../shared/agent-session-conversation-view'
import { testOrcaSessionId } from '../../../../shared/orca-session-address-test-fixture'
import { formatOrcaSessionAddress } from '../../../../shared/orca-session-address'
import type { MountedCrewProducerModule } from '../../../../shared/orchestration-crew-mounted.test-fixture'

const snapshotMetrics = new WeakMap<object, { snapshotSerializations: number }>()
const stringify = JSON.stringify

export const createMountedCrewProducer: MountedCrewProducerModule['createMountedCrewProducer'] =
  () => {
    const f = fixture()
    const sessionId = testOrcaSessionId('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa')
    const address = formatOrcaSessionAddress(sessionId)
    const record = agentSessionConversationView(agentSessionRecordFixture({ sessionId }))
    f.deps.records = {
      listRecords: () => [record],
      getRecord: (id) => (id === sessionId ? record : null),
      getVisibleSessionTabIndex: () => ({ present: true, sessionIds: [sessionId] })
    }
    f.db.insertMessage({ from: address, to: 'term_worker', subject: 'Peer', body: 'Retained L' })
    f.db.insertMessage({ from: 'term_peer', to: 'term_helper', subject: 'Other', body: 'Other L' })
    const metrics = { reads: 0, acquisitions: 0, frames: 0, snapshotSerializations: 0 }
    vi.spyOn(JSON, 'stringify').mockImplementation((value, replacer, space) => {
      if (typeof value === 'object' && value !== null) {
        const observed = snapshotMetrics.get(value)
        if (observed) {
          observed.snapshotSerializations++
        }
      }
      return stringify(value, replacer, space)
    })
    const model = new CrewReadModel(() => {
      metrics.acquisitions++
      return f.deps
    }, f.db.crewChanges.subscribe)
    let restoreRun: string | undefined
    return {
      address,
      metrics,
      subscribe: (party, emit) =>
        subscribeCrew(
          () => {
            metrics.reads++
            const snapshot = model.read(party)
            snapshotMetrics.set(snapshot, metrics)
            return snapshot
          },
          model.subscribe,
          (frame) => {
            metrics.frames++
            emit(frame)
          }
        ),
      removeAddress: () => {
        const create = () =>
          f.db.createRun({
            objective: 'Remembered owner',
            coordinatorHandle: null,
            coordinatorPaneKey: null,
            coordinatorOrcaSessionId: sessionId
          })
        create()
        restoreRun = create().id
        f.db.unbindOtherRunsForCoordinator({
          terminalHandle: null,
          paneKey: null,
          orcaSessionId: sessionId
        })
      },
      restoreAddress: () => {
        if (!restoreRun) {
          throw new Error('Expected two remembered Run owners')
        }
        f.db.bindRun({
          runId: restoreRun,
          coordinatorHandle: null,
          coordinatorPaneKey: null,
          coordinatorOrcaSessionId: sessionId
        })
      },
      equalOwnerWake: () => {
        f.db.rememberRunCoordinatorHandle(f.run.id, 'term_unrelated_history')
      }
    }
  }
