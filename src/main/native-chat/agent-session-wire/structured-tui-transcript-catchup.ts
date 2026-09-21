import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { NativeChatMessage } from '../../../shared/native-chat-types'
import type { AgentSessionHandleProvider } from '../../../shared/agent-session-provider-handle'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import {
  appendLegacyTranscriptMessages,
  importLegacyTranscriptIntoJournal
} from '../agent-session-journal/journal-legacy-import'
import { resolveSessionFilePath } from '../session-file-resolver'
import {
  readIncrementalTranscriptMessages,
  type IncrementalTranscriptState
} from '../transcript-incremental-reader'
import { nativeChatLineDecoderForAgent } from '../transcript-tail-reader'
import {
  subscribeNativeChatTranscript,
  type NativeChatTranscriptSubscription
} from '../transcript-watch'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import {
  readStructuredTuiTranscriptBoundary,
  writeStructuredTuiTranscriptBoundary
} from './structured-tui-transcript-boundary'

type CatchupState = {
  active: boolean
  fence: number
  agent: AgentSessionHandleProvider
  providerSessionId: string
  pending: NativeChatMessage[]
  seen: Set<string>
  subscription: NativeChatTranscriptSubscription | null
}

export class StructuredTuiTranscriptCatchup {
  private readonly states = new Map<string, CatchupState>()

  constructor(
    private readonly input: {
      store: AgentSessionRecordStore
      session: (sessionId: string) => StructuredAgentSessionHostSession
      schedule: (sessionId: string, task: () => Promise<void>) => Promise<void>
      publish: (sessionId: string) => void
      reset: (sessionId: string, fence: number) => void
      onError?: (input: { sessionId: string; error: unknown }) => void
    }
  ) {}

  async prepare(sessionId: string, fence: number): Promise<void> {
    await this.start(sessionId, fence, false)
  }

  async recover(sessionId: string, fence: number): Promise<void> {
    await this.start(sessionId, fence, true)
  }

  private async start(sessionId: string, fence: number, recovering: boolean): Promise<void> {
    this.stop(sessionId)
    const record = this.input.store.getRecord(sessionId)
    const head = record?.providerHandleChain.at(-1)
    if (
      !record ||
      !head ||
      (head.handle.provider !== 'codex' && head.handle.provider !== 'claude')
    ) {
      return
    }
    const agent = head.handle.provider
    const providerSessionId = agent === 'claude' ? head.handle.sessionId : head.handle.threadId
    const journal = this.input.session(sessionId).journal
    const transcriptOptions =
      agent === 'claude'
        ? { claudeProjectsDir: join(record.accountHome.path, 'projects') }
        : { codexSessionsDirs: [join(record.accountHome.path, 'sessions')] }
    const boundary = recovering
      ? await readStructuredTuiTranscriptBoundary(journal.directory)
      : null
    const filePath = await resolveSessionFilePath(agent, providerSessionId, {
      ...transcriptOptions,
      ...(boundary?.filePath ? { transcriptPath: boundary.filePath } : {})
    })
    let initialReady: (() => void) | null = null
    let baselineOffset = 0
    const ready = filePath ? new Promise<void>((resolve) => (initialReady = resolve)) : null
    const state: CatchupState = {
      active: false,
      fence,
      agent,
      providerSessionId,
      pending: [],
      seen: new Set(),
      subscription: null
    }
    const receive = (messages: NativeChatMessage[]) => this.receive(sessionId, state, messages)
    this.states.set(sessionId, state)
    try {
      state.subscription = await subscribeNativeChatTranscript({
        agent,
        sessionId: providerSessionId,
        ...transcriptOptions,
        ...(filePath ? { filePath, initialLimit: 0 } : {}),
        onInitialSnapshot: (messages, _hasMore, beforeOffset) => {
          baselineOffset = beforeOffset
          receive(messages)
          initialReady?.()
          initialReady = null
        },
        onAppend: receive
      })
      await ready
      if (!recovering) {
        await writeStructuredTuiTranscriptBoundary(journal.directory, {
          providerSessionId,
          runtimeFence: fence,
          filePath,
          offset: baselineOffset
        })
      } else if (
        filePath &&
        boundary?.providerSessionId === providerSessionId &&
        boundary.runtimeFence === fence &&
        boundary.filePath === filePath
      ) {
        await this.readRecoveryGap(sessionId, state, filePath, boundary.offset)
      } else if (filePath) {
        const imported = await importLegacyTranscriptIntoJournal({
          journal,
          agent,
          sessionId: providerSessionId,
          fence,
          options: { filePath, decodedMessageIdentities: true }
        })
        if (!imported.ok) {
          throw new Error(imported.error)
        }
        this.input.reset(sessionId, fence)
      }
    } catch (error) {
      if (this.states.get(sessionId) === state) {
        this.states.delete(sessionId)
      }
      state.subscription?.unsubscribe()
      throw error
    }
  }

  private async readRecoveryGap(
    sessionId: string,
    state: CatchupState,
    filePath: string,
    offset: number
  ): Promise<void> {
    let size: number
    try {
      size = (await stat(filePath)).size
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return
      }
      throw error
    }
    const start = offset <= size ? offset : 0
    const incremental: IncrementalTranscriptState = {
      offset: start,
      pendingChunks: [],
      pendingStart: start,
      pendingBytes: 0,
      droppingOversizedRecord: false
    }
    const decode = nativeChatLineDecoderForAgent(state.agent)
    if (!decode) {
      throw new Error('Transcript unavailable')
    }
    let messages: NativeChatMessage[]
    try {
      messages = await readIncrementalTranscriptMessages(filePath, incremental, decode)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return
      }
      throw error
    }
    this.receive(sessionId, state, messages)
  }

  async activate(sessionId: string): Promise<void> {
    const state = this.states.get(sessionId)
    if (!state) {
      return
    }
    state.active = true
    const pending = state.pending.splice(0)
    await this.append(sessionId, state, pending)
  }

  stop(sessionId: string): void {
    const state = this.states.get(sessionId)
    this.states.delete(sessionId)
    state?.subscription?.unsubscribe()
  }

  stopAll(): void {
    for (const sessionId of this.states.keys()) {
      this.stop(sessionId)
    }
  }

  private receive(sessionId: string, state: CatchupState, messages: NativeChatMessage[]): void {
    if (this.states.get(sessionId) !== state) {
      return
    }
    if (!state.active) {
      state.pending.push(...messages)
      return
    }
    void this.input
      .schedule(sessionId, () => this.append(sessionId, state, messages))
      .catch((error) => this.input.onError?.({ sessionId, error }))
  }

  private async append(
    sessionId: string,
    state: CatchupState,
    messages: NativeChatMessage[]
  ): Promise<void> {
    if (this.states.get(sessionId) !== state) {
      return
    }
    const record = this.input.store.getRecord(sessionId)
    if (
      !record ||
      record.lease.runtimeKind !== 'tui' ||
      record.lease.claimStatus !== 'live' ||
      record.lease.runtimeFence !== state.fence
    ) {
      return
    }
    const ids = new Set(state.seen)
    const fresh = messages.filter((message) => {
      if (ids.has(message.id)) {
        return false
      }
      ids.add(message.id)
      return true
    })
    if (fresh.length === 0) {
      return
    }
    try {
      await appendLegacyTranscriptMessages({
        journal: this.input.session(sessionId).journal,
        agent: state.agent,
        sessionId: state.providerSessionId,
        fence: state.fence,
        messages: fresh
      })
      for (const message of fresh) {
        state.seen.add(message.id)
      }
      this.input.publish(sessionId)
    } catch (error) {
      this.input.onError?.({ sessionId, error })
    }
  }
}
