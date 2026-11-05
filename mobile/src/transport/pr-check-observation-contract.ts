import { z } from 'zod'
import type { RpcClient, SendRequestOptions } from './rpc-client'
import type { RpcOperationSender } from './rpc-operation-sender'
import { captureGitHubInvocation, supportsExactGitHubOperations } from './github-target-invocation'
import {
  readRuntimeStatusProbe,
  recordRuntimeStatusProbe,
  runtimeStatusProbeEpoch
} from './runtime-status-probe'
import { GITHUB_COMPLETE_PR_CHECK_OBSERVATION_CAPABILITY } from '../../../src/shared/source-control/runtime/source-control-runtime-capabilities'

type Status = Awaited<ReturnType<ReturnType<typeof captureGitHubInvocation>['status']>>
type Discovery = {
  epoch: string
  pending?: Promise<Status | null | undefined>
  attempted: boolean
  status?: Status
}
const discoveries = new WeakMap<RpcClient, Discovery>()
const statusSchema = z.object({
  runtimeId: z.string().optional(),
  hostDescriptor: z.object({ installationId: z.string() }).optional(),
  capabilities: z.array(z.string()).optional()
})
const sourceSchema = z.object({
  runtimeId: z.string(),
  hostDescriptor: z.object({ installationId: z.string() })
})
const supporting = (status: Status | null | undefined) =>
  status?.capabilities?.includes(GITHUB_COMPLETE_PR_CHECK_OBSERVATION_CAPABILITY) === true

function knownStatus(client: RpcClient): Status | null | undefined {
  const prior = discoveries.get(client)
  const proof = prior?.epoch === runtimeStatusProbeEpoch(client) ? prior.status : undefined
  const cached = readRuntimeStatusProbe(client)
  const value = cached === undefined ? client.getShellHostStatus?.() : cached
  const parsed = statusSchema.safeParse(value)
  if (!parsed.success) {
    return proof ?? (value === undefined ? undefined : null)
  }
  const status = parsed.data
  if (supporting(proof) && (!status.runtimeId || status.runtimeId === proof?.runtimeId)) {
    return {
      ...proof,
      ...status,
      runtimeId: proof?.runtimeId,
      hostDescriptor: proof?.hostDescriptor,
      capabilities: proof?.capabilities
    }
  }
  if (supporting(status) && prior) {
    prior.status = status
  }
  return status
}

function statusFor(client: RpcClient, refresh: boolean): Promise<Status | null | undefined> {
  const known = knownStatus(client)
  const epoch = runtimeStatusProbeEpoch(client)
  let entry = discoveries.get(client)
  if (!entry || entry.epoch !== epoch) {
    entry = { epoch, attempted: known !== undefined, status: known ?? undefined }
    discoveries.set(client, entry)
  }
  if (!entry.pending && (!entry.attempted || refresh)) {
    entry.attempted = true
    const invocation = captureGitHubInvocation(client)
    const captured = entry
    captured.pending = invocation
      .status({ timeoutMs: 15_000, failWhenDisconnected: true })
      .then(
        (status) => {
          const accepted =
            supporting(known) && status.runtimeId === known?.runtimeId
              ? { ...status, capabilities: known?.capabilities }
              : status
          if (supporting(accepted)) {
            captured.status = accepted
          }
          recordRuntimeStatusProbe(client, accepted)
          return accepted
        },
        () => known
      )
      .finally(() => {
        captured.pending = undefined
        invocation.retire()
      })
  }
  // Unknown/legacy reads proceed immediately. A user refresh of a known capable producer relearns a relayed restart.
  return refresh && supporting(known) && entry.pending ? entry.pending : Promise.resolve(known)
}

export async function captureMobilePRCheckContract(
  sender: RpcOperationSender,
  params: { repo: string },
  refresh = false
) {
  if (!isRpcClient(sender)) {
    return {
      scope: undefined,
      complete: false,
      current: () => true,
      options: {} satisfies SendRequestOptions,
      routeCurrent: () => true,
      retire: () => {}
    }
  }
  const origin = sender
  const route = () => origin.requestRoute?.(params) ?? { client: origin }
  const { client, intermediary } = route()
  const sameRoute = () => {
    const next = route()
    return next.client === client && next.intermediary === intermediary
  }
  const invocation = captureGitHubInvocation(client, sameRoute)
  const relayInvocation = intermediary && captureGitHubInvocation(intermediary, sameRoute)
  const [status, relay] = await Promise.all([
    statusFor(client, refresh),
    intermediary ? statusFor(intermediary, refresh) : null
  ])
  const source = sourceSchema.safeParse(status)
  const complete =
    status?.capabilities?.includes(GITHUB_COMPLETE_PR_CHECK_OBSERVATION_CAPABILITY) === true &&
    source.success &&
    (!intermediary ||
      (relay &&
        supportsExactGitHubOperations(relay) &&
        (client.carriesRpcEnvelope?.() ?? true))) === true
  const started = runtimeStatusProbeEpoch(client)
  const routeCurrent = () => {
    try {
      invocation.assertCurrent()
      relayInvocation?.assertCurrent()
      const now = knownStatus(client)
      return (
        runtimeStatusProbeEpoch(client) === started &&
        (!source.success || now?.runtimeId === source.data.runtimeId)
      )
    } catch {
      return false
    }
  }
  const current = () =>
    routeCurrent() &&
    (knownStatus(client)?.capabilities?.includes(
      GITHUB_COMPLETE_PR_CHECK_OBSERVATION_CAPABILITY
    ) ===
      true) ===
      (status?.capabilities?.includes(GITHUB_COMPLETE_PR_CHECK_OBSERVATION_CAPABILITY) === true)
  const beforeSend = () => {
    invocation.assertCurrent()
    relayInvocation?.assertCurrent()
  }
  return {
    scope: source.success
      ? `${source.data.hostDescriptor.installationId}:${source.data.runtimeId}:${started}`
      : undefined,
    complete,
    current,
    routeCurrent,
    client,
    retire: () => {
      invocation.retire()
      relayInvocation?.retire()
    },
    options: {
      beforeSend,
      ...(complete && source.success
        ? {
            envelope: {
              expectedRuntimeSource: {
                sourceId: source.data.hostDescriptor.installationId,
                runtimeId: source.data.runtimeId
              }
            }
          }
        : {})
    } satisfies SendRequestOptions
  }
}
function isRpcClient(sender: RpcOperationSender): sender is RpcClient {
  return 'getState' in sender
}
