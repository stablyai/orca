import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener'
import type {
  AgentLaunchPreferences,
  RuntimeCreateAgentSessionRequest,
  RuntimeCreateAgentSessionResult,
  RuntimeEnsureAgentSessionRequest,
  RuntimeEnsureAgentSessionResult
} from '../../../shared/agent-session-host-authority'
import type { NativeChatMessage } from '../../../shared/native-chat-types'
import type {
  RoomAttachment,
  RoomRunningAgent,
  RoomContextSnapshot,
  RoomEvent,
  RoomExistingAgentCandidate,
  RoomHarnessAgent,
  RoomProviderSession
} from '../../../shared/rooms'
import type {
  RuntimeTerminalAgentStatus,
  RuntimeTerminalClose,
  RuntimeTerminalSend,
  RuntimeTerminalWait
} from '../../../shared/runtime-types'
import type { NativeChatTranscriptSubscription } from '../../native-chat/transcript-watch'
import type { RoomHarnessLifecycleEvent } from './harness-lifecycle'
import type { RoomDeletionManifest } from './database'

export type RoomHarnessBinding = {
  worktreeId: string
  terminalHandle: string
  paneKey: string
  providerSession: RoomProviderSession | null
  disposition?: 'created' | 'adopted'
  terminalSurfaceVisible?: boolean
}

export type RoomHarnessRuntime = {
  createAgentSession(
    request: RuntimeCreateAgentSessionRequest
  ): Promise<RuntimeCreateAgentSessionResult>
  ensureAgentSession(
    request: RuntimeEnsureAgentSessionRequest
  ): Promise<RuntimeEnsureAgentSessionResult>
  sendTerminalAgentPrompt(
    handle: string,
    prompt: string,
    options?: {
      beforeWrite?: (ptyId: string) => void | Promise<void>
      clearInput?: boolean
      imagePaths?: readonly string[]
    }
  ): Promise<RuntimeTerminalSend>
  sendTerminal?(
    handle: string,
    action: { text?: string; enter?: boolean; interrupt?: boolean }
  ): Promise<RuntimeTerminalSend>
  waitForTerminalAgentInputReady(handle: string, agent: RoomHarnessAgent): Promise<boolean>
  compactTerminalAgentSession(handle: string): Promise<RuntimeTerminalSend>
  getTerminalAgentStatus(
    handle: string,
    options?: { confirmForeground?: boolean }
  ): Promise<RuntimeTerminalAgentStatus>
  getTerminalProcessIncarnation(handle: string): string | null
  closeTerminal(
    handle: string,
    options?: { force?: boolean; waitForExit?: boolean }
  ): Promise<RuntimeTerminalClose>
  waitForTerminal(
    handle: string,
    options?: { condition?: 'exit' | 'tui-idle'; timeoutMs?: number; signal?: AbortSignal }
  ): Promise<RuntimeTerminalWait>
  focusTerminal?(
    handle: string,
    options?: { navigateHost?: boolean; viewMode?: 'terminal' | 'chat' }
  ): Promise<unknown>
  hasPersistedTerminalSurface?(worktreeId: string, paneKey: string): boolean
  hideRoomAgentStatusFromRenderer?(paneKey: string): void
  publishRoomAgentProviderSession?(
    handle: string,
    agent: RoomHarnessAgent,
    providerSession: RoomProviderSession,
    force?: boolean
  ): void
  emitRoomEvent?(roomId: string, event: RoomEvent): void
  listRoomRunningAgents(worktreeId: string): Promise<RoomRunningAgent[]>
  listRoomExistingAgents(
    worktreeId: string,
    agent: RoomHarnessAgent
  ): Promise<RoomExistingAgentCandidate[]>
  resolveRoomHistoricalSession(
    worktreeId: string,
    agent: RoomHarnessAgent,
    historyId: string
  ): Promise<RoomProviderSession>
  stageRoomAttachment(
    worktreeId: string,
    terminalHandle: string,
    attachment: Pick<RoomAttachment, 'id' | 'fileName' | 'localPath'>
  ): Promise<string>
  cleanupDeletedRoomResources?(manifest: RoomDeletionManifest): Promise<void>
}

export type RoomHarnessReadResult =
  | { messages: NativeChatMessage[]; hasMore: boolean; beforeOffset: number }
  | { error: string; notFound?: true }

export type RoomHarnessSubscriptionCallbacks = {
  onSnapshot: (messages: NativeChatMessage[]) => void
  onEvent: (event: RoomHarnessLifecycleEvent) => void
  onOpaqueAppend: () => void
}

export type RoomHarnessAdapter = {
  readonly agent: RoomHarnessAgent
  launch(worktreeId: string): Promise<RoomHarnessBinding>
  connectExisting(input: {
    worktreeId: string
    terminalHandle?: string
    paneKey?: string
    historyId?: string
  }): Promise<RoomHarnessBinding>
  locate(binding: RoomHarnessBinding): Promise<RoomHarnessBinding | null>
  read(binding: RoomHarnessBinding, limit?: number): Promise<RoomHarnessReadResult>
  send(
    binding: RoomHarnessBinding,
    prompt: string,
    options?: {
      beforeWrite?: (ptyId: string) => void | Promise<void>
      clearInput?: boolean
      imagePaths?: readonly string[]
    }
  ): Promise<RuntimeTerminalSend>
  interrupt(binding: RoomHarnessBinding): Promise<void>
  prepareControl?(binding: RoomHarnessBinding, command: string): Promise<void>
  stop(binding: RoomHarnessBinding): Promise<RuntimeTerminalClose>
  restore(
    binding: RoomHarnessBinding,
    preferences?: AgentLaunchPreferences
  ): Promise<RoomHarnessBinding>
  reconfigure(
    binding: RoomHarnessBinding,
    preferences: AgentLaunchPreferences
  ): Promise<RoomHarnessBinding>
  status(binding: RoomHarnessBinding): Promise<RuntimeTerminalAgentStatus>
  incarnation(binding: RoomHarnessBinding): string | null
  awaitReady(binding: RoomHarnessBinding): Promise<RuntimeTerminalWait>
  awaitInputReady(binding: RoomHarnessBinding): Promise<boolean>
  context(binding: RoomHarnessBinding, current: RoomContextSnapshot): Promise<RoomContextSnapshot>
  lastTranscriptActivityAt(binding: RoomHarnessBinding): Promise<number | null>
  compact(binding: RoomHarnessBinding): Promise<RuntimeTerminalSend>
  stageAttachment(
    binding: RoomHarnessBinding,
    attachment: Pick<RoomAttachment, 'id' | 'fileName' | 'localPath'>
  ): Promise<string>
  statusEvent(
    event: AgentHookEventPayload & { receivedAt: number }
  ): RoomHarnessLifecycleEvent | null
  subscribe(
    binding: RoomHarnessBinding,
    callbacks: RoomHarnessSubscriptionCallbacks
  ): Promise<NativeChatTranscriptSubscription>
}
