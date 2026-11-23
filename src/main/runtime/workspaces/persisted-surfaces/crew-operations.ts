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
import { OrcaRuntimeWithWebhookOperations } from './webhook-operations'
import { subscribeWorkerApprovals } from '../../orchestration/crew/worker-approval-stream'
import { readCrewApprovals } from '../../orchestration/crew/crew-query'
import { parseOrcaSessionAddress } from '../../../../shared/agent-session/identity/orca-session-address'
import type { OrchestrationWorkerApprovalsFrame } from '../../../../shared/orchestration/orchestration-crew'

import { accountMoveReleases } from '../../agent-session/environment/account-move-releases'
import type { StructuredAgentSessionRuntimeDeps } from '../../agent-session/installation/structured-agent-session-runtime-contract'
import {
  structuredWorkerIncarnation,
  structuredWorkerOwesWork
} from '../../orchestration/terminal-authority/structured-sessions/structured-worker-custody'
import {
  takeStructuredWorkerDispatchEnds,
  watchStructuredWorkerDispatchEnds
} from '../../orchestration/terminal-authority/structured-sessions/structured-worker-dispatch-closes'

export abstract class OrcaRuntimeWithCrewOperations extends OrcaRuntimeWithWebhookOperations {
  abstract readonly agentTransitions: Pick<AgentTransitionDetector, 'subscribe'>

  private unwatchCrewDb: (() => void) | undefined
  // Not a field initializer: a base constructor can bind the database before this class's fields run.
  declare private orchestrationDbChangesSlot: CrewChanges | undefined
  /** The orchestration database's own changes (Runs, Dispatches, mail), without terminal identity's. */
  private get orchestrationDbChanges(): CrewChanges {
    return (this.orchestrationDbChangesSlot ??= new CrewChanges())
  }

  /** Structured-chat host deps that follow orchestration Dispatches. */
  protected structuredDispatchHostDeps(): Pick<
    StructuredAgentSessionRuntimeDeps,
    'hasOpenDispatch' | 'accountMoveWakes'
  > {
    return {
      // Re-read dispatch ownership each sweep; absence of a database cannot keep the worker alive.
      hasOpenDispatch: (record) =>
        structuredWorkerOwesWork(this.getOrchestrationDbIfAvailable?.() ?? null, record),
      // A Dispatch settling can release a chat's sends held for an account move.
      accountMoveWakes: accountMoveReleases(
        this.orchestrationDbChanges,
        () => {
          try {
            return this.requireStore()
          } catch {
            // A runtime without settings never moves a chat between accounts.
            return null
          }
        },
        {
          watch: () => {
            const db = this.getOrchestrationDbIfAvailable?.()
            if (db) {
              watchStructuredWorkerDispatchEnds(db)
            }
          },
          take: () => {
            const db = this.getOrchestrationDbIfAvailable?.()
            return db ? takeStructuredWorkerDispatchEnds(db) : []
          },
          key: structuredWorkerIncarnation
        }
      )
    }
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
        // Read only while no database is bound: a status wake must not stat the disk.
        !this._orchestrationDb && existsSync(this.orchestrationDbPath()),
        getPublishedHostDescriptor(this.runtimeId)?.installationId ?? this.runtimeId,
        previous
      ),
    (wake, relevance, idle) =>
      watchCrewRuntimeSources(
        {
          store: this.store,
          watchChanges: this.crewChanges.subscribeWithIdle,
          watchTransitions: (listener) => this.agentTransitions.subscribe(listener),
          watchClient: (listener) => this.onClientEvent(listener)
        },
        wake,
        relevance,
        idle
      )
  )

  getOrchestrationCrewSnapshot(party: string) {
    return this.crewReadModel.read(party)
  }

  /** Wakes for changes `party`'s rows can show. */
  watchOrchestrationCrew = (party: string) => (wake: () => void) =>
    this.crewReadModel.subscribe(wake, party)

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
