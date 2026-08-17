import { Buffer } from 'node:buffer'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import {
  activeStructuredAgentSessionTurnId,
  projectStructuredItemsToNativeChat
} from '../../../shared/structured-agent-session-projection'
import type { StructuredMachineAgent } from '../../../shared/structured-agent-provider'
import type { RoomContextSnapshot } from '../../../shared/rooms'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { isEmptyCodexRoomSession } from './empty-codex-room-session'
import { attachMachineRoomSession } from './machine-room-session-attach'
import type {
  RoomHarnessLaunchOptions,
  RoomHarnessReadResult,
  RoomHarnessRuntime,
  RoomHarnessSubscriptionCallbacks,
  RoomMachineHarnessBinding
} from './harness-adapter-types'
import {
  createRoomMachineBinding,
  readStructuredRoomState,
  structuredRoomCaller,
  structuredRoomHolderId,
  structuredRoomHost,
  structuredRoomMutationEnvelope
} from './machine-harness-session'
import {
  applyMachineRoomPreferences,
  machineRoomInputReady,
  machineRoomLastActivityAt,
  readMachineRoomContext,
  readMachineRoomReady,
  readMachineRoomStatus,
  subscribeMachineRoomSession
} from './machine-room-session-observation'

type MachineExistingInput = {
  worktreeId: string
  conversationId?: string
  providerSessionId?: string
}

export class MachineRoomHarnessAdapter {
  constructor(
    readonly agent: StructuredMachineAgent,
    private readonly runtime: RoomHarnessRuntime
  ) {}

  async launch(
    worktreeId: string,
    options?: RoomHarnessLaunchOptions
  ): Promise<RoomMachineHarnessBinding> {
    return this.attach(worktreeId, options)
  }

  async connectExisting(
    input: MachineExistingInput,
    options?: RoomHarnessLaunchOptions
  ): Promise<RoomMachineHarnessBinding> {
    if (!input.conversationId) {
      if (!input.providerSessionId) {
        throw new Error('room_historical_session_not_found')
      }
      return this.attach(input.worktreeId, options, input.providerSessionId)
    }
    const ensureHost = this.runtime.ensureStructuredAgentSessionHost?.bind(this.runtime)
    if (!ensureHost) {
      throw new Error('structured_agent_session_unsupported')
    }
    await ensureHost()
    const host = structuredRoomHost()
    if (!host.hasSession(input.conversationId)) {
      await host.restoreReadableSessions([input.conversationId])
    }
    const session = host
      .listSessionTabs()
      .find((candidate) => candidate.sessionId === input.conversationId)
    if (!session || session.workspaceId !== input.worktreeId || session.agent !== this.agent) {
      throw new Error('conversation_identity_conflict')
    }
    const history = host.history({
      sessionId: input.conversationId,
      direction: 'tail',
      limit: 1
    })
    const binding = createRoomMachineBinding(
      input.worktreeId,
      input.conversationId,
      'adopted',
      history.providerSession?.id
    )
    const ready = await this.holdOrRestartEmpty(binding)
    try {
      await this.applyPreferences(ready, options?.preferences)
      return ready
    } catch (error) {
      host.release(ready.conversationId, structuredRoomHolderId(ready))
      throw error
    }
  }

  private async attach(
    worktreeId: string,
    options?: RoomHarnessLaunchOptions,
    providerSessionId?: string,
    emptyRecord?: AgentSessionRecord
  ): Promise<RoomMachineHarnessBinding> {
    return attachMachineRoomSession({
      agent: this.agent,
      runtime: this.runtime,
      worktreeId,
      options,
      providerSessionId,
      emptyRecord
    })
  }

  async locate(value: RoomMachineHarnessBinding): Promise<RoomMachineHarnessBinding | null> {
    try {
      const ensureHost = this.runtime.ensureStructuredAgentSessionHost?.bind(this.runtime)
      if (!ensureHost) {
        return null
      }
      await ensureHost()
      if (!structuredRoomHost().hasSession(value.conversationId)) {
        await structuredRoomHost().restoreReadableSessions([value.conversationId])
      }
      return structuredRoomHost().hasSession(value.conversationId)
        ? { ...value, disposition: 'adopted' }
        : null
    } catch {
      return null
    }
  }

  async read(value: RoomMachineHarnessBinding, limit = 200): Promise<RoomHarnessReadResult> {
    const result = structuredRoomHost().history({
      sessionId: value.conversationId,
      direction: 'tail',
      limit
    })
    return {
      messages: projectStructuredItemsToNativeChat(result.page.items),
      hasMore: result.page.hasOlder,
      beforeOffset: result.page.window.oldest?.sequence ?? 0
    }
  }

  async send(
    value: RoomMachineHarnessBinding,
    prompt: string,
    options?: { imagePaths?: readonly string[] }
  ): Promise<{ handle: string; accepted: boolean; bytesWritten: number }> {
    const body: AgentJournalMessageItem = {
      kind: 'message',
      role: 'user',
      blocks: [
        ...(prompt ? [{ type: 'text' as const, text: prompt }] : []),
        ...(options?.imagePaths ?? []).map((path) => ({ type: 'image-ref' as const, path }))
      ]
    }
    const result = await structuredRoomHost().send(structuredRoomCaller(value), {
      envelope: structuredRoomMutationEnvelope(value.conversationId, 'agentSession.send', { body }),
      body
    })
    return {
      handle: value.conversationId,
      accepted: result.ok && result.value.submission.dispatchState === 'accepted',
      bytesWritten: result.ok ? Buffer.byteLength(prompt) : 0
    }
  }

  async steer(
    value: RoomMachineHarnessBinding,
    prompt: string,
    options?: { imagePaths?: readonly string[] }
  ): Promise<{ handle: string; accepted: boolean; bytesWritten: number }> {
    const body: AgentJournalMessageItem = {
      kind: 'message',
      role: 'user',
      blocks: [
        ...(prompt ? [{ type: 'text' as const, text: prompt }] : []),
        ...(options?.imagePaths ?? []).map((path) => ({ type: 'image-ref' as const, path }))
      ]
    }
    const result = await structuredRoomHost().steer(structuredRoomCaller(value), {
      envelope: structuredRoomMutationEnvelope(value.conversationId, 'agentSession.steer', {
        body
      }),
      body
    })
    return {
      handle: value.conversationId,
      accepted: result.ok && result.value.submission.dispatchState === 'accepted',
      bytesWritten: result.ok ? Buffer.byteLength(prompt) : 0
    }
  }

  async interrupt(value: RoomMachineHarnessBinding): Promise<void> {
    const turnId = activeStructuredAgentSessionTurnId(
      readStructuredRoomState(value.conversationId).items
    )
    if (!turnId) {
      return
    }
    const result = await structuredRoomHost().cancel(structuredRoomCaller(value), {
      envelope: structuredRoomMutationEnvelope(value.conversationId, 'agentSession.cancel', {
        turnId
      }),
      turnId
    })
    if (!result.ok) {
      throw new Error(result.refusal.message)
    }
  }

  compact(value: RoomMachineHarnessBinding) {
    return this.send(value, '/compact')
  }

  async stop(value: RoomMachineHarnessBinding) {
    await this.interrupt(value)
    structuredRoomHost().release(value.conversationId, structuredRoomHolderId(value))
    await structuredRoomHost().close(value.conversationId)
    return { handle: value.conversationId, tabId: value.conversationId, ptyKilled: true }
  }

  async restore(
    value: RoomMachineHarnessBinding,
    preferences?: RoomHarnessLaunchOptions['preferences']
  ): Promise<RoomMachineHarnessBinding> {
    if (!(await this.locate(value))) {
      const sourceSessionId = value.providerSession.sourceSessionId
      if (!sourceSessionId) {
        throw new Error('conversation_not_found')
      }
      return this.attach(value.worktreeId, preferences && { preferences }, sourceSessionId)
    }
    return this.holdOrRestartEmpty(value)
  }

  private async holdOrRestartEmpty(
    value: RoomMachineHarnessBinding
  ): Promise<RoomMachineHarnessBinding> {
    const host = structuredRoomHost()
    try {
      await host.hold(value.conversationId, structuredRoomHolderId(value))
    } catch (error) {
      const record = host.deps.store.getRecord(value.conversationId)
      if (
        this.agent !== 'codex' ||
        record?.location.workspaceId !== value.worktreeId ||
        !isEmptyCodexRoomSession(record, host.deps.journalRoot, error)
      ) {
        throw error
      }
      const created = await this.attach(value.worktreeId, undefined, undefined, record)
      host.release(value.conversationId, structuredRoomHolderId(value))
      return created
    }
    return { ...value, disposition: 'adopted' }
  }

  async reconfigure(
    value: RoomMachineHarnessBinding,
    preferences: NonNullable<RoomHarnessLaunchOptions['preferences']>
  ): Promise<RoomMachineHarnessBinding> {
    await this.applyPreferences(value, preferences)
    return { ...value, disposition: 'adopted' }
  }

  async status(value: RoomMachineHarnessBinding) {
    return readMachineRoomStatus(value)
  }

  incarnation = (): null => null

  async awaitReady(value: RoomMachineHarnessBinding) {
    return readMachineRoomReady(value)
  }

  async awaitInputReady(value: RoomMachineHarnessBinding): Promise<boolean> {
    return machineRoomInputReady(value)
  }

  async context(
    value: RoomMachineHarnessBinding,
    current: RoomContextSnapshot
  ): Promise<RoomContextSnapshot> {
    return readMachineRoomContext(this.agent, value, current)
  }

  async lastTranscriptActivityAt(value: RoomMachineHarnessBinding): Promise<number> {
    return machineRoomLastActivityAt(value)
  }

  stageAttachment(
    value: RoomMachineHarnessBinding,
    attachment: { id: string; fileName: string; localPath: string }
  ): Promise<string> {
    return this.runtime.stageRoomAttachment(value.worktreeId, undefined, attachment)
  }

  subscribe(value: RoomMachineHarnessBinding, callbacks: RoomHarnessSubscriptionCallbacks) {
    return subscribeMachineRoomSession(value, callbacks)
  }

  private async applyPreferences(
    value: RoomMachineHarnessBinding,
    preferences?: RoomHarnessLaunchOptions['preferences']
  ): Promise<void> {
    await applyMachineRoomPreferences(value, preferences)
  }
}
