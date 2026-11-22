// What a paired server's removal or re-pair ends here: the Run work it held, and the questions this
// Orca's agents asked agents there.
import type { OrcaRuntimeService } from '../../../orca-runtime'
import type { OrchestrationDb } from '../../db/orchestration-db'
import type { OrchestrationWorkerServer } from '../environment-transport'
import {
  closeRemoteRunLinksOfChangedPairing,
  closeRemoteRunLinksOfRemovedServer,
  remoteServerPin
} from '../../db/remote-owned/remote-run-links'
import { tellUnpairedPeerQuestions } from './peer-questions-out'

/** Its Runs' Tasks here fail with why, and the askers still waiting on it are told. */
export function settleRemovedPairedServer(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  environmentId: string,
  serverName: string
): void {
  const reason = `${serverName} was removed from this Orca's paired servers.`
  closeRemoteRunLinksOfRemovedServer(db, environmentId, reason, (handle, type) =>
    runtime.notifyMessageArrived(handle, type)
  )
  tellUnpairedPeerQuestions(runtime, db, { environmentId, serverName, reason })
}

/** Work and questions sent under an older pairing are lost with it. */
export function settleRepairedServer(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  server: OrchestrationWorkerServer
): void {
  closeRemoteRunLinksOfChangedPairing(db, remoteServerPin(server), server.name, (handle, type) =>
    runtime.notifyMessageArrived(handle, type)
  )
  tellUnpairedPeerQuestions(runtime, db, { environmentId: server.environmentId, server })
}
