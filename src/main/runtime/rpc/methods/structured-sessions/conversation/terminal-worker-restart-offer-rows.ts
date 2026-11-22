// One restart offer for a person to act on: cut chats, and terminal workers a reboot or daemon crash took
// while Resume work on restart was off. Ids name a chat or an offered worker's Dispatch, never both.

import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { StructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-host'
import {
  restartRowsFor,
  type StructuredAgentSessionRestartAudience,
  type StructuredAgentSessionResumeCandidate
} from '../../../../../native-chat/agent-session-wire/recovery/structured-agent-session-restart-resume-set'
import type { StructuredAgentSessionRestartResume } from '../../../../../native-chat/agent-session-wire/recovery/structured-agent-session-restart-resume-contract'

type OfferRuntime = Pick<OrcaRuntimeService, 'terminalWorkerRestartOffers'>
type OfferHost = Pick<StructuredAgentSessionHost, 'restartResume'>

function workerIds(
  runtime: OfferRuntime,
  ids: readonly string[] | undefined,
  audience: StructuredAgentSessionRestartAudience | undefined
): string[] {
  // An unnamed action covers only the workers this client is shown.
  return ids === undefined
    ? restartRowsFor(runtime.terminalWorkerRestartOffers.list(), audience).map(
        (row) => row.sessionId
      )
    : runtime.terminalWorkerRestartOffers.owned(ids)
}

export async function listRestartOffers(
  runtime: OfferRuntime,
  host: OfferHost,
  audience: StructuredAgentSessionRestartAudience | undefined
): Promise<StructuredAgentSessionResumeCandidate[]> {
  return [
    ...(await host.restartResume.list(audience)),
    ...restartRowsFor(runtime.terminalWorkerRestartOffers.list(), audience)
  ]
}

export async function dismissRestartOffers(
  runtime: OfferRuntime,
  host: OfferHost,
  ids: readonly string[] | undefined,
  audience: StructuredAgentSessionRestartAudience | undefined
): Promise<number> {
  const workers = workerIds(runtime, ids, audience)
  const chats = ids?.filter((id) => !workers.includes(id))
  const dismissedChats =
    chats === undefined || chats.length > 0 ? await host.restartResume.dismiss(chats, audience) : 0
  return dismissedChats + runtime.terminalWorkerRestartOffers.dismiss(workers)
}

export async function continueRestartOffers(
  runtime: OfferRuntime,
  host: OfferHost,
  ids: readonly string[] | undefined,
  owner: string,
  audience: StructuredAgentSessionRestartAudience | undefined
): Promise<Awaited<ReturnType<StructuredAgentSessionRestartResume['continueAfterRestart']>>> {
  const workers = workerIds(runtime, ids, audience)
  const chats = ids?.filter((id) => !workers.includes(id))
  type Answer = Awaited<ReturnType<StructuredAgentSessionRestartResume['continueAfterRestart']>>
  const none: Answer = { resumed: [], continued: [] }
  const [answer, resumedWorkers] = await Promise.all([
    chats === undefined || chats.length > 0
      ? host.restartResume.continueAfterRestart(chats, owner, audience)
      : Promise.resolve(none),
    runtime.terminalWorkerRestartOffers.continue(workers)
  ])
  return {
    ...answer,
    continued: [...answer.continued, ...resumedWorkers],
    // What is left to offer is read after both settled, so a resumed worker is no longer listed.
    sessions: await listRestartOffers(runtime, host, audience),
    failed: answer.failed ?? (await host.restartResume.listFailures(audience))
  }
}
