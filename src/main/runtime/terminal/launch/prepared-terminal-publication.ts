import { isTuiAgent } from '../../../../shared/tui-agent-config'
import type { PreparedTerminalPrompts } from '../../../daemon/prepared-agent-launch-protocol'
import type { AgentSessionOperationRow } from '../../../../shared/agent-session-operation-ledger'
import {
  isPreparedAgentLaunchDescriptor,
  isPreparedAgentLaunchStatus,
  type PreparedAgentLaunchIdentity,
  type PreparedAgentLaunchDescriptor,
  type PreparedAgentLaunchStatus
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
  deliverPrompts: (
    terminal: RuntimeTerminalCreate,
    prompts: PreparedTerminalPrompts
  ) => Promise<boolean>
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
  const key = JSON.stringify(identity)
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
      await ports.store.retirePreparedAgentLaunch(identity)
      return null
    }
    throw new Error('agent_session_ownership_unknown')
  }
  if (status.execution === 'settled') {
    await controller.preparedAgentLaunch({ action: 'ackPublication', identity })
    await controller.preparedAgentLaunch({ action: 'claimPrompt', identity })
    await controller.preparedAgentLaunch({ action: 'settlePrompt', identity })
    const retired = await controller.preparedAgentLaunch({ action: 'retireInput', identity })
    if (isPreparedAgentLaunchStatus(retired) && retired.retirement === 'unused-retired') {
      await ports.store.retirePreparedAgentLaunch(identity)
    }
    return null
  }
  if (!status.published && descriptor.presentation.primary) {
    await ports.placePrimary?.(descriptor)
  }
  const terminal = await ports.createTerminal(`id:${descriptor.surface.worktreeId}`, {
    ...currentOptions,
    command: undefined,
    env: undefined,
    tabId: descriptor.surface.tabId,
    leafId: descriptor.surface.leafId,
    preAllocatedHandle: descriptor.surface.terminalHandle,
    sessionId: status.physical.sessionId,
    expectedIncarnationId: status.physical.incarnationId,
    attachOnly: true,
    launchAgent: descriptor.claim.agent,
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
  const prompts = await controller.preparedAgentLaunch({ action: 'claimPrompt', identity })
  if (isPreparedTerminalPrompts(prompts) && (await ports.deliverPrompts(terminal, prompts))) {
    await controller.preparedAgentLaunch({ action: 'settlePrompt', identity })
  }
  const retirement = await controller.preparedAgentLaunch({ action: 'retireInput', identity })
  if (isPreparedAgentLaunchStatus(retirement) && retirement.retirement === 'unused-retired') {
    await ports.store.retirePreparedAgentLaunch(identity)
  }
  return terminal
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
      // Observation detaches on connection failure; the saved obligation remains authoritative.
      try {
        await publishPreparedTerminal(identity, row.preparedLaunch, ports)
      } catch {
        // Retain the exact owner for the next connection reconciliation.
      }
    })
  )
}

function isPreparedTerminalPrompts(value: unknown): value is PreparedTerminalPrompts {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  for (const key of ['draft', 'followup'] as const) {
    if (!(key in value)) {
      continue
    }
    const prompt = Reflect.get(value, key)
    if (typeof prompt !== 'object' || prompt === null || !isTuiAgent(prompt.agent)) {
      return false
    }
    if (typeof (key === 'draft' ? prompt.content : prompt.prompt) !== 'string') {
      return false
    }
  }
  return true
}
