import { createHash } from 'node:crypto'
import {
  forgetPreparedPromptContinuation,
  joinPreparedPromptContinuation,
  preparedLaunchKey
} from './prepared-terminal-prompt-delivery'
import { provesPreparedLaunchOwnerGone } from './prepared-terminal-owner-demise'
export { preparedPromptUncertainText } from './prepared-terminal-prompt-delivery'
import type { AgentSessionOperationRow } from '../../../../shared/agent-session-operation-ledger'
import {
  isPreparedAgentLaunchDescriptor,
  isPreparedAgentLaunchStatus,
  parsePreparedLaunchPublication,
  type PreparedAgentLaunchIdentity,
  type PreparedAgentLaunchDescriptor,
  type PreparedAgentLaunchStatus,
  type PreparedAgentLaunchNotice,
  type PreparedLaunchPublication
} from '../../../../shared/prepared-agent-launch'
import type { RuntimeTerminalCreate } from '../../../../shared/runtime-types'
import type { AgentSessionRecordStore } from '../../agent-session-record-store'
import type { RuntimePtyController } from '../../runtime-pty-controller-contract'
import type { TerminalCreateOptions } from '../../runtime-terminal-contracts'
import { parsePaneKey } from '../../../../shared/stable-pane-id'

export type PreparedPublicationPorts = {
  controller: RuntimePtyController
  store: Pick<AgentSessionRecordStore, 'listOperationRows' | 'retirePreparedAgentLaunch'>
  createTerminal: (
    selector: string,
    options: TerminalCreateOptions
  ) => Promise<RuntimeTerminalCreate>
  setTabColor: (handle: string, color: string) => Promise<void>
  placePrimary?: (descriptor: PreparedAgentLaunchDescriptor) => Promise<unknown>
  /** One short desktop notice for an outcome no surviving terminal shows. */
  notifyLaunchNotice?: (notice: PreparedAgentLaunchNotice) => void
}
const publications = new WeakMap<
  RuntimePtyController,
  Map<string, Promise<RuntimeTerminalCreate | null>>
>()

export async function readPreparedTerminalStatus(
  controller: RuntimePtyController,
  identity: PreparedAgentLaunchIdentity
): Promise<PreparedAgentLaunchStatus> {
  if (!controller.preparedAgentLaunch) {
    throw new Error('prepared_agent_launch_unsupported')
  }
  const status = await controller.preparedAgentLaunch({ action: 'status', identity })
  if (!isPreparedAgentLaunchStatus(status)) {
    throw new Error('agent_session_ownership_unknown')
  }
  return status
}

/** Rejoin only the exact physical result. Changed settings cannot authorize another spawn. */
export function publishPreparedTerminal(
  identity: PreparedAgentLaunchIdentity,
  descriptor: PreparedAgentLaunchDescriptor,
  ports: PreparedPublicationPorts,
  currentOptions: TerminalCreateOptions = { surfaceOwner: false }
): Promise<RuntimeTerminalCreate | null> {
  const pending =
    publications.get(ports.controller) ?? new Map<string, Promise<RuntimeTerminalCreate | null>>()
  publications.set(ports.controller, pending)
  // Callers may pass a wider pending receipt; only the exact launch identity joins a publication.
  const key = preparedLaunchKey(identity)
  const existing = pending.get(key)
  if (existing) {
    return existing
  }
  const publication = publish(identity, descriptor, ports, currentOptions).finally(() => {
    if (pending.get(key) === publication) {
      pending.delete(key)
    }
  })
  pending.set(key, publication)
  return publication
}

async function publish(
  identity: PreparedAgentLaunchIdentity,
  descriptor: PreparedAgentLaunchDescriptor,
  ports: PreparedPublicationPorts,
  currentOptions: TerminalCreateOptions
): Promise<RuntimeTerminalCreate | null> {
  const { controller } = ports
  if (!controller.preparedAgentLaunch) {
    throw new Error('prepared_agent_launch_unsupported')
  }
  let status = await readPreparedTerminalStatus(controller, identity)
  let setupPublished = await publishPreparedSetup(descriptor, status, ports)
  while (status.execution === 'not-dispatched' || status.execution === 'dispatching') {
    const next = await controller.preparedAgentLaunch({
      action: 'wait',
      identity,
      timeoutMs: 10_000,
      until: descriptor.setup && !setupPublished ? 'setup' : 'launch'
    })
    if (!isPreparedAgentLaunchStatus(next)) {
      throw new Error('agent_session_ownership_unknown')
    }
    status = next
    if (!setupPublished) {
      setupPublished = await publishPreparedSetup(descriptor, status, ports)
    }
  }
  if (!status.physical) {
    if (status.retirement === 'unused-retired') {
      // Failure and deadline already wrote into the surviving Setup terminal; never say it twice.
      await retirePreparedDescriptor(
        ports,
        identity,
        descriptor,
        status.failure === 'setup-ended' ? { notice: 'setup-closed' } : {}
      )
      return null
    }
    throw new Error('agent_session_ownership_unknown')
  }
  if (status.execution === 'settled') {
    // The agent started and ended before publication; its unwritten prompt dies with the descriptor.
    const retired = await controller.preparedAgentLaunch({ action: 'retireInput', identity })
    if (isPreparedAgentLaunchStatus(retired) && retired.retirement === 'unused-retired') {
      await retirePreparedDescriptor(ports, identity, descriptor)
    }
    return null
  }
  const publication = await readPreparedPublication(controller, identity, descriptor)
  if (!status.published && descriptor.presentation.primary) {
    await ports.placePrimary?.(descriptor)
  }
  // Recipe, view and authority come only from the daemon's accepted launch, initial or recovered.
  const {
    launchConfig: _launchConfig,
    viewMode: _viewMode,
    launchToken: _launchToken,
    ...attachOptions
  } = currentOptions
  const terminal = await ports.createTerminal(`id:${descriptor.surface.worktreeId}`, {
    ...attachOptions,
    command: undefined,
    env: undefined,
    tabId: descriptor.surface.tabId,
    leafId: descriptor.surface.leafId,
    preAllocatedHandle: descriptor.surface.terminalHandle,
    sessionId: status.physical.sessionId,
    expectedIncarnationId: status.physical.incarnationId,
    attachOnly: true,
    launchAgent: descriptor.claim.agent,
    ...(publication.launchConfig ? { launchConfig: publication.launchConfig } : {}),
    ...(publication.launchToken ? { launchToken: publication.launchToken } : {}),
    // A later user view change belongs to the tab; only the first publication applies the request.
    ...(publication.viewMode && !status.published ? { viewMode: publication.viewMode } : {}),
    ...(descriptor.presentation.title ? { title: descriptor.presentation.title } : {}),
    ...(descriptor.presentation.groupId ? { targetGroupId: descriptor.presentation.groupId } : {}),
    ...(descriptor.presentation.splitPlacement?.afterTabId
      ? { afterTabId: descriptor.presentation.splitPlacement.afterTabId }
      : {})
  })
  if (
    terminal.ptyId !== status.physical.sessionId ||
    terminal.incarnationId !== status.physical.incarnationId ||
    terminal.handle !== descriptor.surface.terminalHandle
  ) {
    throw new Error('agent_session_ownership_unknown')
  }
  if (descriptor.presentation.color) {
    await ports.setTabColor(terminal.handle, descriptor.presentation.color)
  }
  await controller.preparedAgentLaunch({ action: 'ackPublication', identity })
  // Any observer may publish; only the creator writes, and every observer returns its one answer.
  const answer = await joinPreparedPromptContinuation(identity, descriptor, terminal)
  // Recording is bookkeeping: a failed write keeps the answer for the next observation, never the input.
  await controller
    .preparedAgentLaunch({ action: 'retireInput', identity })
    .then((retirement) =>
      isPreparedAgentLaunchStatus(retirement) && retirement.retirement === 'unused-retired'
        ? retirePreparedDescriptor(ports, identity, descriptor, {
            answer,
            ...(answer.warning ? { notice: 'prompt-uncertain' as const } : {})
          })
        : undefined
    )
    .catch(() => {})
  return answer
}

async function readPreparedPublication(
  controller: RuntimePtyController,
  identity: PreparedAgentLaunchIdentity,
  descriptor: PreparedAgentLaunchDescriptor
): Promise<PreparedLaunchPublication> {
  const status = await controller.preparedAgentLaunch?.({
    action: 'status',
    identity,
    publication: true
  })
  const publication =
    typeof status === 'object' && status !== null && 'publication' in status
      ? parsePreparedLaunchPublication(status.publication)
      : undefined
  const token = publication?.launchToken
  // The saved hash is the authority this launch was recorded with; a different token is not ours.
  if (
    token !== undefined &&
    createHash('sha256').update(token).digest('hex') !== descriptor.launchTokenHash
  ) {
    throw new Error('agent_session_ownership_unknown')
  }
  return publication ?? {}
}

async function retirePreparedDescriptor(
  ports: PreparedPublicationPorts,
  identity: PreparedAgentLaunchIdentity,
  descriptor: PreparedAgentLaunchDescriptor,
  result: { answer?: RuntimeTerminalCreate; notice?: PreparedAgentLaunchNotice['kind'] } = {}
): Promise<void> {
  const removed = await ports.store.retirePreparedAgentLaunch({
    ...identity,
    ...(result.answer ? { answer: result.answer } : {})
  })
  forgetPreparedPromptContinuation(identity)
  // Only the transaction that consumed the descriptor shows its outcome; observers and retries never repeat it.
  if (removed && result.notice) {
    ports.notifyLaunchNotice?.({
      operationId: identity.operationId,
      worktreeId: descriptor.surface.worktreeId,
      agent: descriptor.claim.agent,
      kind: result.notice
    })
  }
}

async function publishPreparedSetup(
  descriptor: PreparedAgentLaunchDescriptor,
  status: PreparedAgentLaunchStatus,
  ports: PreparedPublicationPorts
): Promise<boolean> {
  if (!descriptor.setup || !ports.controller.listProcesses) {
    return true
  }
  if (!status.setup?.incarnationId) {
    return false
  }
  const setup = descriptor.setup
  const sessions = await ports.controller.listProcesses()
  const session = sessions.find((entry) => entry.id === setup.sessionId)
  const pane = session?.paneKey ? parsePaneKey(session.paneKey) : null
  if (
    !session ||
    !pane ||
    session.incarnationId !== status.setup.incarnationId ||
    session.terminalHandle !== setup.terminalHandle
  ) {
    return true
  }
  await ports.createTerminal(`id:${descriptor.surface.worktreeId}`, {
    ...pane,
    title: 'Setup',
    sessionId: setup.sessionId,
    expectedIncarnationId: status.setup.incarnationId,
    preAllocatedHandle: setup.terminalHandle,
    attachOnly: true,
    surfaceOwner: false
  })
  return true
}

export async function reconcilePreparedTerminalPublications(
  ports: PreparedPublicationPorts
): Promise<void> {
  const rows: AgentSessionOperationRow[] = ports.store.listOperationRows()
  const pass = { generations: new Map<string, Promise<boolean>>() }
  await Promise.all(
    rows.map(async (row) => {
      if (!isPreparedAgentLaunchDescriptor(row.preparedLaunch)) {
        return
      }
      const identity = {
        operationId: row.operationId,
        fingerprint: row.fingerprint,
        daemonGeneration: row.preparedLaunch.daemonGeneration,
        reservationGeneration: row.preparedLaunch.reservationGeneration
      }
      const descriptor = row.preparedLaunch
      // Observation detaches on connection failure; the saved obligation remains authoritative.
      try {
        await publishPreparedTerminal(identity, descriptor, ports)
      } catch (error) {
        // Unreachable is not gone: retain the exact owner unless its demise is proven.
        if (await provesPreparedLaunchOwnerGone(error, descriptor, pass).catch(() => false)) {
          await retirePreparedDescriptor(ports, identity, descriptor).catch(() => {})
        }
      }
    })
  )
}
