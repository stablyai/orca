import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { botOfHomeWorkspace } from '../../shared/bots/bot-homes'
import type { AgentSessionRecord } from '../../shared/agent-session/lifecycle/agent-session-record'
import { agentSessionOwnerObservationIsLive } from '../../shared/agent-session/lifecycle/leases/agent-session-lease-adjudication'
import { isNativeLocalLocation } from '../../shared/execution-host/execution-host'
import {
  readAgentSessionRecordStore,
  resolveLineageRunningSession
} from '../runtime/orchestration/addressing/session-lineage/structured-session-lineage'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { principal, epoch, type Principal } from './commander-recovery-account'
import { askHomeMemoryPreference } from './commander-memory-service'

type Launch = {
  digest: Buffer
  sessionId: string
  botId: string
  fence: number
  expires: number
  owner: Principal
}
type Host = { runtime: OrcaRuntimeService; generation: number; launch?: Launch }
let desktop: Host | null = null
const lifetimeMs = 8 * 60 * 60 * 1000
const digest = (value: string) => createHash('sha256').update(value).digest()

export function installCommanderHomePreferences(runtime: OrcaRuntimeService): () => void {
  const host = { runtime, generation: 0 }
  desktop = host
  return () => {
    if (desktop === host) {
      desktop = null
    }
  }
}

function home(host: Host) {
  const bot =
    host.runtime.bots.enabled() &&
    host.runtime.bots.list().find((candidate) => candidate.systemRole === 'commander')
  if (!bot || !bot.chatSessionId) {
    return null
  }
  const live = resolveLineageRunningSession(readAgentSessionRecordStore(), bot.chatSessionId)
  if (
    live.kind !== 'here' ||
    !isNativeLocalLocation(live.record.location) ||
    !botOfHomeWorkspace([bot], live.record.location.workspaceId)
  ) {
    return null
  }
  return { bot, record: live.record }
}

export async function commanderHomeLaunchCapability(
  record: AgentSessionRecord
): Promise<string | null> {
  const host = desktop
  if (
    !host ||
    record.location.workspaceKind !== 'folder' ||
    !isNativeLocalLocation(record.location)
  ) {
    return null
  }
  function sameHome() {
    const current = host && home(host)
    return current &&
      current.record.sessionId === record.sessionId &&
      current.record.currentFence === record.lease.runtimeFence &&
      current.record.provider === record.provider &&
      ['live', 'reserved'].includes(current.record.ownerObservation.claimStatus)
      ? current
      : null
  }
  const current = sameHome()
  if (!current) {
    return null
  }
  // The capability only accompanies this live launch; normal bot/connector tokens also reach sibling chats.
  host.launch = undefined
  const generation = ++host.generation
  const owner = await principal().catch(() => null)
  if (
    !owner ||
    desktop !== host ||
    host.generation !== generation ||
    sameHome()?.bot.id !== current.bot.id ||
    owner.ticket !== epoch(owner.account)
  ) {
    return null
  }
  const capability = randomBytes(32).toString('base64url')
  host.launch = {
    digest: digest(capability),
    sessionId: record.sessionId,
    botId: current.bot.id,
    fence: record.lease.runtimeFence,
    expires: Date.now() + lifetimeMs,
    owner
  }
  return capability
}

export async function askFromCommanderHome(
  runtime: OrcaRuntimeService,
  params: {
    capability: string
    projectId: string
    question: string
    requestId: string
  }
) {
  const host = desktop
  const grant = host?.launch
  const refusal = () =>
    new Error(
      'Start a new local Commander Home chat while signed in, and use a registered project.'
    )
  if (
    !host ||
    host.runtime !== runtime ||
    !grant ||
    !timingSafeEqual(grant.digest, digest(params.capability))
  ) {
    throw refusal()
  }
  function assertCurrent() {
    const current = host && home(host)
    if (
      !host ||
      !grant ||
      desktop !== host ||
      host.launch !== grant ||
      Date.now() >= grant.expires ||
      grant.owner.ticket !== epoch(grant.owner.account) ||
      current?.bot.id !== grant.botId ||
      current.record.sessionId !== grant.sessionId ||
      current.record.currentFence !== grant.fence ||
      !agentSessionOwnerObservationIsLive(current.record.ownerObservation) ||
      !runtime.listVisibleProjectHostSetups().some((setup) => setup.projectId === params.projectId)
    ) {
      throw refusal()
    }
  }
  assertCurrent()
  const answer = await askHomeMemoryPreference(
    grant.owner.account,
    grant.botId,
    params.projectId,
    params.question,
    params.requestId,
    assertCurrent
  )
  assertCurrent()
  return answer
}
