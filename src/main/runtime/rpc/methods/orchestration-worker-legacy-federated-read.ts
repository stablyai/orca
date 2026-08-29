import type { ORCHESTRATION_WORKER_READ_SOURCES } from '../../../../shared/orchestration-worker-output'
import type { RuntimeTerminalRead } from '../../../../shared/runtime-types'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import {
  createWorkerOutputSourceIdentity,
  decodeWorkerOutputCursor,
  encodeWorkerOutputCursor
} from '../../orchestration/worker-output-cursor'
import type { resolvePinnedFederatedServer } from './orchestration-worker-observation'

// Pre-structured-output servers only expose raw terminal reads; keep that path fenced and
// cursor-scoped so an old peer never silently degrades a transcript cursor.
export async function readLegacyFederatedTerminal(args: {
  runtime: Parameters<typeof resolvePinnedFederatedServer>[0]
  server: ReturnType<typeof resolvePinnedFederatedServer>
  federated: Parameters<typeof resolvePinnedFederatedServer>[1]
  workerState: string
  dispatchId: string
  source: (typeof ORCHESTRATION_WORKER_READ_SOURCES)[number] | undefined
  cursor: string | number | undefined
  limit: number | undefined
}) {
  const cursor = decodeWorkerOutputCursor(args.cursor, args.dispatchId)
  if (args.source === 'transcript' || cursor?.source === 'transcript') {
    throw new OrchestrationError(
      'transcript_required',
      `Connected server ${args.server.name} does not support structured worker output.`,
      { reason: 'remote_capability_unavailable' }
    )
  }
  const remote = (await args.runtime.callOrchestrationWorkerServer(
    args.server.environmentId,
    'orchestration.federationRead',
    {
      dispatchId: args.dispatchId,
      cursor: cursor?.source === 'terminal' ? cursor.position : undefined,
      limit: args.limit
    },
    15_000
  )) as { runtimeEpoch: string; terminal: RuntimeTerminalRead }
  const sourceIdentity = createWorkerOutputSourceIdentity([
    'legacy-remote-terminal',
    args.federated.peer_fingerprint,
    args.dispatchId,
    remote.runtimeEpoch
  ])
  if (
    cursor?.source === 'terminal' &&
    cursor.sourceIdentity !== null &&
    cursor.sourceIdentity !== sourceIdentity
  ) {
    throw new OrchestrationError(
      'source_changed',
      'The worker output source changed. Start a fresh worker-read without the old cursor.'
    )
  }
  const nextPosition =
    remote.terminal.nextCursor !== null && /^\d+$/.test(remote.terminal.nextCursor)
      ? Number.parseInt(remote.terminal.nextCursor, 10)
      : null
  return {
    dispatchId: args.dispatchId,
    source: 'terminal' as const,
    sourceIdentity,
    terminal: remote.terminal,
    cursor:
      nextPosition === null
        ? null
        : encodeWorkerOutputCursor(args.dispatchId, 'terminal', sourceIdentity, nextPosition),
    status: { worker: args.workerState, terminal: remote.terminal.status },
    fallbackReason: 'remote_capability_unavailable' as const,
    warnings: [],
    server: { environmentId: args.server.environmentId, name: args.server.name },
    remoteRuntimeEpoch: remote.runtimeEpoch
  }
}
