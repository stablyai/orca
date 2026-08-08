/* eslint-disable max-lines -- Why: room participant lifecycle and transcript state update atomically. */
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener'
import type { ClaudeStatusLineRateLimits } from '../../../shared/claude-statusline-rate-limits'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import type { Room, RoomEvent, RoomHarnessAgent, RoomParticipant } from '../../../shared/rooms'
import type { RoomDatabase } from './database'
import type { RoomHarnessAdapter, RoomHarnessBinding } from './harness-adapter'
import type { RoomTranscriptBridge } from './transcript-bridge'
import { isAgentSessionControlCommand } from '../../../shared/agent-session-control-command'
import type { AgentLaunchPreferences } from '../../../shared/agent-session-host-authority'
import {
  codexEffortFromChoices,
  findCatalogModel,
  findCatalogOption,
  getAgentSessionOptionCatalog
} from '../../../shared/agent-session-option-catalog'

/** An idle harness process costs hundreds of MB; a sleeping participant is a DB
 *  row. The provider thread, model/effort and worktree persist, so the existing
 *  restore path wakes the agent on the next delivery. */
export const ROOM_AGENT_IDLE_SLEEP_MS = 30 * 60 * 1000

const HIBERNATION_SWEEP_MS = 5 * 60 * 1000
const CONTROL_CONFIRMATION_TIMEOUT_MS = 10_000
const CONTROL_CONFIRMATION_POLL_MS = 100

export type RoomParticipantConnection =
  | { kind: 'launch'; worktreeId: string }
  | {
      kind: 'attach'
      worktreeId: string
      terminalHandle: string
      paneKey: string
    }
  | { kind: 'resume'; worktreeId: string; historyId: string }

/** Only preferences the catalog marks restart-scoped die with the process and
 *  must be re-applied on relaunch (codex model/effort; claude keeps them in-session). */
function restartScopedPreferences(
  participant: RoomParticipant
): AgentLaunchPreferences | undefined {
  if (!participant.agent) {
    return undefined
  }
  const catalog = getAgentSessionOptionCatalog(
    participant.agent === 'openclaude' ? 'claude' : participant.agent
  )
  if (!catalog) {
    return undefined
  }
  const preferences: AgentLaunchPreferences = {}
  const { model, effort, fastMode } = participant.context
  // capturesOptionsInLaunchCommand: flags die with the process and must be re-applied.
  // OR legacy kind==='restart' fallback for catalogs not yet using the new flag.
  if (
    model &&
    (catalog.capturesOptionsInLaunchCommand || catalog.modelApply.midSession?.kind === 'restart')
  ) {
    preferences.model = model
  }
  const effortOption =
    findCatalogOption(findCatalogModel(catalog, model ?? ''), 'effort') ??
    // Codex enumerates models only via the live provider; its catalog seed is empty.
    (participant.agent === 'codex' ? codexEffortFromChoices() : undefined)
  if (
    effort &&
    (catalog.capturesOptionsInLaunchCommand || effortOption?.apply.midSession?.kind === 'restart')
  ) {
    preferences.effort = effort
  }
  if (typeof fastMode === 'boolean' && catalog.capturesOptionsInLaunchCommand) {
    preferences.mode = fastMode ? 'fast' : 'standard'
  }
  return preferences.model || preferences.effort || preferences.mode ? preferences : undefined
}

export class RoomParticipantController {
  private readonly restoring = new Map<string, Promise<RoomParticipant>>()
  private hibernationTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly db: RoomDatabase,
    private readonly adapters: Record<RoomHarnessAgent, RoomHarnessAdapter>,
    private readonly transcriptBridge: RoomTranscriptBridge,
    private readonly emit: (roomId: string, event: RoomEvent) => void
  ) {}

  startHibernationSweep(): void {
    this.hibernationTimer = setInterval(
      () => void this.hibernateIdle().catch(() => {}),
      HIBERNATION_SWEEP_MS
    )
    this.hibernationTimer.unref?.()
  }

  dispose(): void {
    if (this.hibernationTimer) {
      clearInterval(this.hibernationTimer)
      this.hibernationTimer = null
    }
  }

  async add(input: {
    roomId: string
    identity: string
    displayName: string
    agent: RoomHarnessAgent
    roleId?: string | null
    connection: RoomParticipantConnection
  }): Promise<RoomParticipant> {
    const room = this.db.core.get(input.roomId)
    this.assertProject(room, input.connection.worktreeId)
    const adapter = this.adapters[input.agent]
    const binding = await this.connect(adapter, input.connection)
    try {
      let participant = this.db.participants.add({
        roomId: input.roomId,
        identity: input.identity,
        displayName: input.displayName,
        agent: input.agent,
        roleId: input.roleId,
        worktreeId: binding.worktreeId,
        paneKey: binding.paneKey,
        terminalHandle: binding.terminalHandle,
        providerSession: binding.providerSession,
        processIncarnation: adapter.incarnation(binding)
      })
      participant = this.db.participants.update(participant.id, { state: 'starting' })
      this.emit(input.roomId, { type: 'participant.updated', participant })
      await this.transcriptBridge.ensure(participant)
      return await this.waitUntilReady(participant, binding.disposition === 'created')
    } catch (error) {
      if (binding.disposition === 'created') {
        await adapter.stop(binding).catch(() => {})
      }
      throw error
    }
  }

  async remove(id: string): Promise<void> {
    const participant = this.db.participants.get(id)
    if (this.db.core.get(participant.roomId).archivedAt) {
      throw new Error('room_archived')
    }
    const binding = this.binding(participant)
    if (participant.agent && binding) {
      await this.adapters[participant.agent].stop(binding)
    }
    this.transcriptBridge.disposeParticipant(id)
    this.db.participants.remove(id)
    this.emit(participant.roomId, { type: 'participant.removed', participantId: id })
  }

  async restore(participant: RoomParticipant, requireReady = false): Promise<RoomParticipant> {
    const active = this.restoring.get(participant.id)
    if (active) {
      const restored = await active
      return requireReady ? this.waitUntilReady(restored) : restored
    }
    const restore = this.restoreParticipant(participant, requireReady).finally(() => {
      this.restoring.delete(participant.id)
    })
    this.restoring.set(participant.id, restore)
    return restore
  }

  async ensureReady(id: string): Promise<RoomParticipant> {
    let participant = this.db.participants.get(id)
    const adapter = participant.agent ? this.adapters[participant.agent] : null
    const binding = this.binding(participant)
    if (!adapter || !binding) {
      throw new Error('room_agent_not_attached')
    }
    let status: Awaited<ReturnType<RoomHarnessAdapter['status']>>
    try {
      status = await adapter.status(binding)
    } catch {
      // A persisted handle can be stale after Orca restarts; the provider session is durable.
      return this.restore(participant, true)
    }
    if (status.isRunningAgent) {
      if (status.status === 'permission') {
        throw new Error('room_agent_permission')
      }
      participant = this.updateStatus(participant, true, status.status)
      return status.status === 'idle' ? participant : this.waitUntilReady(participant)
    }
    return this.restore(participant, true)
  }

  /** Room-activation reattach: refresh status of a live harness without forcing
   *  a restart or waiting out a busy turn; restore only a lost one. */
  async reconcile(participant: RoomParticipant): Promise<RoomParticipant> {
    if (participant.state === 'sleeping') {
      // Opening a room must not boot processes; the next delivery wakes.
      return participant
    }
    const adapter = participant.agent ? this.adapters[participant.agent] : null
    const binding = this.binding(participant)
    if (!adapter || !binding) {
      return participant
    }
    try {
      const status = await adapter.status(binding)
      if (status.isRunningAgent) {
        return this.updateStatus(participant, true, status.status)
      }
    } catch {
      // Fall through to restore: the persisted handle is stale.
    }
    return this.restore(participant)
  }

  /** Stops harness processes of provably idle participants; only a live agent
   *  reporting 'idle' is stopped, a dead pane is just recorded as sleeping. */
  async hibernateIdle(now = Date.now()): Promise<void> {
    for (const participant of this.db.participants.listIdleAgents(now - ROOM_AGENT_IDLE_SLEEP_MS)) {
      const adapter = participant.agent ? this.adapters[participant.agent] : null
      const binding = this.binding(participant)
      if (!adapter || !binding || this.restoring.has(participant.id)) {
        continue
      }
      // Errors mean "could not decide": the next sweep retries, one stuck
      // participant must not block other rooms.
      await this.hibernate(adapter, participant, binding, now).catch(() => {})
    }
  }

  private async hibernate(
    adapter: RoomHarnessAdapter,
    participant: RoomParticipant,
    binding: RoomHarnessBinding,
    now: number
  ): Promise<void> {
    let current = binding
    let status: Awaited<ReturnType<RoomHarnessAdapter['status']>>
    try {
      status = await adapter.status(binding)
    } catch {
      // Terminal handles die with the Orca session; a probe error therefore
      // proves nothing. Re-locate the live pane by its durable pane identity —
      // otherwise a restart would shield every agent from hibernation forever.
      const located = await adapter.locate(binding)
      if (!located) {
        // Foreground-verified enumeration found no live pane for this agent:
        // nothing is burning RAM, record the truth.
        return this.markSleeping(participant)
      }
      current = located
      participant = this.db.participants.update(participant.id, {
        terminalHandle: located.terminalHandle,
        paneKey: located.paneKey,
        ...(located.providerSession ? { providerSession: located.providerSession } : {})
      })
      status = await adapter.status(located)
    }
    if (status.isRunningAgent) {
      if (status.status === null) {
        // A pane silent since adoption never yields title or hook evidence.
        // The provider transcript is written continuously during any turn, so
        // an old mtime is idleness proven by the conversation's own record.
        const lastWrite = await adapter.lastTranscriptActivityAt(current)
        if (lastWrite === null || lastWrite > now - ROOM_AGENT_IDLE_SLEEP_MS) {
          return
        }
      } else if (status.status !== 'idle') {
        return
      }
      await adapter.stop(current)
    }
    // Reached only with proof: a foreground-verified shell, or our own stop.
    this.markSleeping(participant)
  }

  private markSleeping(participant: RoomParticipant): void {
    const updated = this.db.participants.update(participant.id, { state: 'sleeping' })
    this.emit(updated.roomId, { type: 'participant.updated', participant: updated })
  }

  private async restoreParticipant(
    participant: RoomParticipant,
    requireReady: boolean
  ): Promise<RoomParticipant> {
    const adapter = participant.agent ? this.adapters[participant.agent] : null
    const binding = this.binding(participant)
    if (!adapter || !binding) {
      throw new Error('room_agent_not_attached')
    }
    let current = this.db.participants.update(participant.id, { state: 'starting' })
    this.emit(current.roomId, { type: 'participant.updated', participant: current })
    try {
      const restored = await adapter.restore(binding, restartScopedPreferences(participant))
      const incarnation = adapter.incarnation(restored)
      // Only a proven restart must re-prove readiness: a fresh launch, or both
      // incarnations known and different. Provider-session state survives it.
      const restarted =
        restored.disposition === 'created' ||
        (participant.processIncarnation !== null &&
          incarnation !== null &&
          incarnation !== participant.processIncarnation)
      current = this.db.participants.update(participant.id, {
        worktreeId: restored.worktreeId,
        paneKey: restored.paneKey,
        terminalHandle: restored.terminalHandle,
        providerSession: restored.providerSession,
        // Never erase a known incarnation with a transient null.
        ...(incarnation !== null ? { processIncarnation: incarnation } : {})
      })
      this.emit(current.roomId, { type: 'participant.updated', participant: current })
      await this.transcriptBridge.ensure(current)
      if (!restarted) {
        return requireReady
          ? this.waitUntilReady(current)
          : this.updateStatus(current, true, 'idle')
      }
      try {
        return await this.waitUntilReady(current, true)
      } catch (readinessError) {
        const permission =
          readinessError instanceof Error && readinessError.message === 'room_agent_permission'
        if (requireReady || restored.disposition === 'created' || permission) {
          throw readinessError
        }
        // Adopted long-lived silent PTYs never emit an idle transition; after
        // the bounded wait expires, trust the adoption as before.
        return this.updateStatus(current, true, 'idle')
      }
    } catch (error) {
      current = this.db.participants.update(participant.id, { state: 'error' })
      this.emit(current.roomId, { type: 'participant.updated', participant: current })
      throw error
    }
  }

  async compact(id: string): Promise<RoomParticipant> {
    let participant = this.db.participants.get(id)
    const adapter = participant.agent ? this.adapters[participant.agent] : null
    const binding = this.binding(participant)
    if (!adapter || !binding) {
      throw new Error('room_agent_not_attached')
    }
    participant = this.setCompaction(participant, 'requested')
    try {
      const result = await adapter.compact(binding)
      if (!result.accepted) {
        throw new Error(result.refusedReason ?? 'room_compaction_refused')
      }
      const current = this.db.participants.get(id)
      return current.context.compaction === 'completed'
        ? current
        : this.setCompaction(current, 'running')
    } catch (error) {
      this.setCompaction(
        participant,
        'failed',
        error instanceof Error ? error.message : String(error)
      )
      throw error
    }
  }

  async control(id: string, command: string): Promise<RoomParticipant> {
    let participant = this.db.participants.get(id)
    if (!participant.agent || !isAgentSessionControlCommand(participant.agent, command)) {
      throw new Error('room_agent_control_unsupported')
    }
    if (participant.state === 'busy') {
      throw new Error('room_agent_busy')
    }
    participant = await this.ensureReady(id)
    const adapter = participant.agent ? this.adapters[participant.agent] : null
    const binding = this.binding(participant)
    if (!adapter || !binding) {
      throw new Error('room_agent_not_attached')
    }
    this.transcriptBridge.suppressSessionControl(id)
    try {
      await adapter.prepareControl?.(binding, command)
      const sentAt = Date.now()
      const result = await adapter.send(binding, command)
      if (!result.accepted) {
        throw new Error(result.refusedReason ?? 'room_agent_control_refused')
      }
      const expectedFastMode = claudeFastModeTarget(participant, command)
      if (expectedFastMode !== null) {
        participant = await this.waitForFastModeConfirmation(
          participant,
          adapter,
          binding,
          expectedFastMode,
          sentAt
        )
      }
      return participant
    } catch (error) {
      this.transcriptBridge.clearSessionControlSuppression(id)
      throw error
    }
  }

  private async waitForFastModeConfirmation(
    participant: RoomParticipant,
    adapter: RoomHarnessAdapter,
    binding: RoomHarnessBinding,
    expected: boolean,
    sentAt: number
  ): Promise<RoomParticipant> {
    const baseline = {
      ...participant.context,
      fastMode: !expected,
      observedAt: sentAt
    }
    const deadline = sentAt + CONTROL_CONFIRMATION_TIMEOUT_MS
    while (Date.now() < deadline) {
      const context = await adapter.context(binding, baseline)
      if (context.fastMode === expected) {
        const updated = this.db.participants.update(participant.id, { context })
        this.emit(updated.roomId, { type: 'participant.updated', participant: updated })
        return updated
      }
      await new Promise((resolve) => setTimeout(resolve, CONTROL_CONFIRMATION_POLL_MS))
    }
    throw new Error('room_agent_control_unconfirmed')
  }

  async reconfigure(id: string, preferences: AgentLaunchPreferences): Promise<RoomParticipant> {
    let participant = this.db.participants.get(id)
    const adapter = participant.agent ? this.adapters[participant.agent] : null
    const binding = this.binding(participant)
    if (!adapter || !binding || participant.state === 'busy') {
      throw new Error(participant.state === 'busy' ? 'room_agent_busy' : 'room_agent_not_attached')
    }
    participant = this.db.participants.update(id, { state: 'starting' })
    this.emit(participant.roomId, { type: 'participant.updated', participant })
    this.transcriptBridge.disposeParticipant(id)
    try {
      const configured = await adapter.reconfigure(binding, preferences)
      participant = this.db.participants.update(id, {
        worktreeId: configured.worktreeId,
        paneKey: configured.paneKey,
        terminalHandle: configured.terminalHandle,
        providerSession: configured.providerSession,
        processIncarnation: adapter.incarnation(configured),
        context: {
          ...participant.context,
          model: preferences.model ?? participant.context.model,
          effort: preferences.effort ?? participant.context.effort,
          ...(preferences.mode === 'fast'
            ? { fastMode: true }
            : preferences.mode === 'standard'
              ? { fastMode: false }
              : {}),
          // Fence: transcript rows older than this choice must not revert it.
          observedAt: Date.now()
        }
      })
      this.emit(participant.roomId, { type: 'participant.updated', participant })
      await this.transcriptBridge.ensure(participant)
      return await this.waitUntilReady(participant, true)
    } catch (error) {
      participant = this.db.participants.update(id, { state: 'error' })
      this.emit(participant.roomId, { type: 'participant.updated', participant })
      throw error
    }
  }

  ingestStatus(event: AgentHookEventPayload & { receivedAt: number }): void {
    const current = this.db.participants.findByPaneKey(event.paneKey)
    if (!current || (event.payload.agentType && event.payload.agentType !== current.agent)) {
      return
    }
    const lifecycle = current.agent ? this.adapters[current.agent].statusEvent(event) : null
    const compaction =
      event.hookEventName === 'PreCompact'
        ? 'running'
        : event.hookEventName === 'PostCompact'
          ? 'completed'
          : current.context.compaction
    const state =
      event.payload.state === 'working' || event.payload.state === 'blocked' ? 'busy' : 'online'
    const participant = this.db.participants.update(current.id, {
      state,
      lastSeenAt: event.receivedAt,
      providerSession: event.providerSession ?? current.providerSession,
      context: {
        ...current.context,
        model: event.payload.model ?? current.context.model,
        compaction,
        compactionUpdatedAt:
          compaction === current.context.compaction
            ? current.context.compactionUpdatedAt
            : event.receivedAt
      }
    })
    this.emit(participant.roomId, { type: 'participant.updated', participant })
    this.transcriptBridge.ingestStatus(participant.id, lifecycle)
    void this.transcriptBridge.ensure(participant)
    if (event.hookEventName === 'PostCompact') {
      this.db.deliveryConfiguration.requireFull(participant.id)
      void this.transcriptBridge.refreshContext(participant).catch(() => {})
    }
  }

  ingestClaudeStatusLine(event: ClaudeStatusLineRateLimits): void {
    if (!event.paneKey || (!event.context && !event.model && !event.effort)) {
      return
    }
    const current = this.db.participants.findByPaneKey(event.paneKey)
    if (!current || current.agent !== (event.agent ?? 'claude')) {
      return
    }
    const compacted =
      current.context.compaction === 'running' &&
      current.context.usedTokens !== null &&
      event.context?.usedTokens !== null &&
      event.context?.usedTokens !== undefined &&
      event.context.usedTokens < current.context.usedTokens
    const participant = this.db.participants.update(current.id, {
      context: {
        ...current.context,
        ...event.context,
        ...(event.model ? { model: event.model } : {}),
        ...(event.effort ? { effort: event.effort } : {}),
        ...(event.context && { estimated: event.context.estimated }),
        source: 'statusline',
        observedAt: Date.now(),
        compaction: compacted ? 'completed' : current.context.compaction,
        compactionUpdatedAt: compacted ? Date.now() : current.context.compactionUpdatedAt,
        error: undefined
      }
    })
    if (compacted) {
      this.db.deliveryConfiguration.requireFull(participant.id)
    }
    this.emit(participant.roomId, { type: 'participant.updated', participant })
  }

  private async connect(
    adapter: RoomHarnessAdapter,
    connection: RoomParticipantConnection
  ): Promise<RoomHarnessBinding> {
    if (connection.kind === 'launch') {
      return adapter.launch(connection.worktreeId)
    }
    if (connection.kind === 'resume') {
      return adapter.resume(connection.worktreeId, connection.historyId)
    }
    return adapter.attach({ ...connection, providerSession: null })
  }

  /** Fresh processes also prove their composer is mounted before idle can authorize input. */
  private async waitUntilReady(
    participant: RoomParticipant,
    requireInputReady = false
  ): Promise<RoomParticipant> {
    const adapter = participant.agent ? this.adapters[participant.agent] : null
    const binding = this.binding(participant)
    if (!adapter || !binding) {
      throw new Error('room_agent_not_attached')
    }
    const inputReady = !requireInputReady || (await adapter.awaitInputReady(binding))
    // Present evidence first: an already-idle agent must not wait for a
    // transition that will never fire again.
    const current = await adapter.status(binding).catch(() => null)
    if (current?.isRunningAgent) {
      if (current.status === 'permission') {
        throw new Error('room_agent_permission')
      }
      if (current.status === 'idle') {
        if (!inputReady && !(await adapter.awaitInputReady(binding))) {
          throw new Error('room_agent_not_ready')
        }
        return this.updateStatus(participant, true, current.status)
      }
      if (current.status === null && (inputReady || (await adapter.awaitInputReady(binding)))) {
        return this.updateStatus(participant, true, current.status)
      }
    }
    const wait = await adapter.awaitReady(binding)
    if (!wait.satisfied) {
      throw new Error(wait.blockedReason ? 'room_agent_permission' : 'room_agent_not_ready')
    }
    if (!inputReady && !(await adapter.awaitInputReady(binding))) {
      throw new Error('room_agent_not_ready')
    }
    const status = await adapter.status(binding)
    if (!status.isRunningAgent || (status.status !== null && status.status !== 'idle')) {
      if (status.status === 'permission') {
        throw new Error('room_agent_permission')
      }
      throw new Error('room_agent_not_ready')
    }
    return this.updateStatus(participant, true, 'idle')
  }

  private updateStatus(
    participant: RoomParticipant,
    isRunningAgent: boolean,
    status: Awaited<ReturnType<RoomHarnessAdapter['status']>>['status']
  ): RoomParticipant {
    // A confirmed-live process is the moment its incarnation is reliably
    // readable; capture it here so freshly created PTYs (null at restore
    // time) become recognizable on the next restore.
    const adapter = participant.agent ? this.adapters[participant.agent] : null
    const binding = this.binding(participant)
    const incarnation = isRunningAgent && adapter && binding ? adapter.incarnation(binding) : null
    const nextState = isRunningAgent ? (status === 'working' ? 'busy' : 'online') : 'offline'
    const incarnationChanged =
      incarnation !== null && incarnation !== participant.processIncarnation
    // Browsing rooms reconciles live agents constantly: a no-change reconcile
    // must not rewrite the row or spam participant.updated events.
    if (nextState === participant.state && !incarnationChanged) {
      return participant
    }
    const updated = this.db.participants.update(participant.id, {
      state: nextState,
      ...(incarnationChanged ? { processIncarnation: incarnation } : {})
    })
    this.emit(updated.roomId, { type: 'participant.updated', participant: updated })
    return updated
  }

  private setCompaction(
    participant: RoomParticipant,
    compaction: RoomParticipant['context']['compaction'],
    error?: string
  ): RoomParticipant {
    const updated = this.db.participants.update(participant.id, {
      context: {
        ...participant.context,
        compaction,
        compactionUpdatedAt: Date.now(),
        error
      }
    })
    this.emit(updated.roomId, { type: 'participant.updated', participant: updated })
    return updated
  }

  private binding(participant: RoomParticipant): RoomHarnessBinding | null {
    return participant.terminalHandle && participant.paneKey && participant.worktreeId
      ? {
          worktreeId: participant.worktreeId,
          terminalHandle: participant.terminalHandle,
          paneKey: participant.paneKey,
          providerSession: participant.providerSession
        }
      : null
  }

  private assertProject(room: Room, worktreeId: string): void {
    if (room.archivedAt) {
      throw new Error('room_archived')
    }
    if (room.worktreeId && room.worktreeId !== worktreeId) {
      throw new Error('room_worktree_mismatch')
    }
    if (getRepoIdFromWorktreeId(worktreeId) !== room.projectId) {
      throw new Error('room_worktree_project_mismatch')
    }
  }
}

function claudeFastModeTarget(participant: RoomParticipant, command: string): boolean | null {
  if (participant.agent !== 'claude' && participant.agent !== 'openclaude') {
    return null
  }
  const match = /^\/fast (on|off)$/.exec(command.trim())
  return match ? match[1] === 'on' : null
}
