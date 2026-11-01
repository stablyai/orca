import type { AgentTransitionDetector } from '../../../agent-hooks/agent-transition-detector'
import {
  readCrewRuntimeInputs,
  watchCrewRuntimeSources
} from '../../orchestration/crew/crew-runtime-watch'
import { CrewReadModel } from '../../orchestration/crew/crew-read-model'
import { getPublishedHostDescriptor } from '../../host-descriptor'
import { existsSync } from 'node:fs'
import type { OrchestrationDb } from '../../orchestration/db'
import { OrcaRuntimeWithOrchestrationDatabaseBinding } from './orchestration-database-binding'

export abstract class OrcaRuntimeWithCrewOperations extends OrcaRuntimeWithOrchestrationDatabaseBinding {
  abstract readonly agentTransitions: Pick<AgentTransitionDetector, 'subscribe'>

  private unwatchCrewDb: (() => void) | undefined

  protected bindCrewChanges(db: OrchestrationDb): void {
    this.unwatchCrewDb?.()
    this.unwatchCrewDb = db.crewChanges.subscribe(this.crewChanges.notify)
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
}
