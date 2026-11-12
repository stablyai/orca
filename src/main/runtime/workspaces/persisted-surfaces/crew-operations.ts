import type { AgentTransitionDetector } from '../../../agent-hooks/observations/agent-transition-detector'
import {
  readCrewRuntimeInputs,
  watchCrewRuntimeSources
} from '../../orchestration/crew/crew-runtime-watch'
import { CrewReadModel } from '../../orchestration/crew/crew-read-model'
import { getPublishedHostDescriptor } from '../../hosts/platform-probe/host-descriptor'
import { existsSync } from 'node:fs'
import type { OrchestrationDb } from '../../orchestration/db/orchestration-db'
import { CrewChanges } from '../../orchestration/crew/crew-changes'
import { OrcaRuntimeWithOrchestrationDatabaseBinding } from './orchestration-database-binding'
import { subscribeWorkerApprovals } from '../../orchestration/crew/worker-approval-stream'
import { readCrewApprovals } from '../../orchestration/crew/crew-query'
import { parseOrcaSessionAddress } from '../../../../shared/orca-session-address'
import type { OrchestrationWorkerApprovalsFrame } from '../../../../shared/orchestration/orchestration-crew'

export abstract class OrcaRuntimeWithCrewOperations extends OrcaRuntimeWithOrchestrationDatabaseBinding {
  abstract readonly agentTransitions: Pick<AgentTransitionDetector, 'subscribe'>

  private unwatchCrewDb: (() => void) | undefined
  // Not a field initializer: a base constructor can bind the database before this class's fields run.
  declare private orchestrationDbChangesSlot: CrewChanges | undefined
  /** The orchestration database's own changes (Runs, Dispatches, mail), without terminal identity's. */
  private get orchestrationDbChanges(): CrewChanges {
    return (this.orchestrationDbChangesSlot ??= new CrewChanges())
  }

  protected bindCrewChanges(db: OrchestrationDb): void {
    this.unwatchCrewDb?.()
    this.unwatchCrewDb = db.crewChanges.subscribe((facets) => {
      this.orchestrationDbChanges.notify(facets)
      this.crewChanges.notify(facets)
    })
    this.orchestrationDbChanges.notify()
    this.crewChanges.notify()
  }

  private readonly crewReadModel = new CrewReadModel(
    (previous) =>
      readCrewRuntimeInputs(
        this.crewRuntimeReaders(),
        this._orchestrationDb,
        existsSync(this.orchestrationDbPath()),
        getPublishedHostDescriptor(this.runtimeId)?.installationId ?? this.runtimeId,
        previous
      ),
    (wake) =>
      watchCrewRuntimeSources(
        {
          store: this.store,
          watchChanges: this.crewChanges.subscribe,
          watchTransitions: (listener) => this.agentTransitions.subscribe(listener),
          watchClient: (listener) => this.onClientEvent(listener)
        },
        wake
      )
  )

  getOrchestrationCrewSnapshot(party: string) {
    return this.crewReadModel.read(party)
  }

  watchOrchestrationCrew = (wake: () => void) => this.crewReadModel.subscribe(wake)

  /** A chat coordinator's worker approvals: its own mailbox and its Runs', read only on their changes. */
  subscribeOrchestrationWorkerApprovals(
    party: string,
    emit: (frame: OrchestrationWorkerApprovalsFrame) => void
  ): () => void {
    const orcaSessionId = parseOrcaSessionAddress(party)
    return subscribeWorkerApprovals(
      {
        mailboxes: () => {
          const db = this._orchestrationDb
          return db && orcaSessionId
            ? [
                party,
                ...db
                  .runsBoundToCoordinator({ orcaSessionId, paneKey: null, terminalHandle: null })
                  .map((run) => `run:${run.id}`)
              ]
            : []
        },
        approvals: (mailboxes) => {
          const db = this._orchestrationDb
          return db ? readCrewApprovals(db, mailboxes) : []
        },
        workers: () => this.crewReadModel.read(party).sections.managing,
        // Terminal identity notices (every agent status or title change) say nothing about approvals.
        watch: this.orchestrationDbChanges.subscribe
      },
      emit
    )
  }
}
