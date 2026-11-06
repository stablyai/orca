import { defineMethod } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { NativeChatTerminalQueueRequest } from '../../../../shared/native-chat/native-chat-terminal-queue'
import { AgentSessionJournal } from '../../../native-chat/agent-session-journal/journal-store'
import { TerminalChatQueue } from '../../../native-chat/terminal-chat-queue'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'

const queues = new WeakMap<OrcaRuntimeService, Map<string, Promise<TerminalChatQueue>>>()

async function terminalQueue(
  runtime: OrcaRuntimeService,
  terminal: string
): Promise<TerminalChatQueue> {
  runtime.getHermesChatActivity(terminal)
  let owned = queues.get(runtime)
  if (!owned) {
    owned = new Map()
    queues.set(runtime, owned)
  }
  const existing = owned.get(terminal)
  if (existing) {
    return existing
  }
  const opening = (async () => {
    const leaf = await runtime.showTerminal(terminal)
    if (!leaf) {
      throw new Error('terminal_gone')
    }
    await runtime.ensureStructuredAgentSessionHost()
    const host = getStructuredAgentSessionHost()
    if (!host) {
      throw new Error('terminal_chat_queue_host_unavailable')
    }
    const journal = new AgentSessionJournal({
      identity: {
        sessionId: `terminal-chat:${terminal}`,
        workspaceId: leaf.worktreeId,
        hostId: leaf.executionHostId ?? host.deps.claimKeyId,
        agent: 'hermes',
        providerHandle: null
      },
      database: host.deps.journalDatabase
    })
    await journal.open()
    const queue = new TerminalChatQueue(
      journal,
      () => runtime.getHermesChatActivity(terminal),
      async (text) => {
        if (!runtime.getHermesChatActivity(terminal).inputReady) {
          return false
        }
        let started = false
        try {
          const result = await runtime.sendTerminalAgentPrompt(terminal, text, {
            inputKind: 'driving',
            requireWriteSettlement: true,
            beforeWrite: async () => {
              const activity = runtime.getHermesChatActivity(terminal)
              if (
                (!started && !activity.inputReady) ||
                activity.state === 'working' ||
                activity.state === 'waiting'
              ) {
                throw new Error('terminal_chat_not_idle')
              }
              const screen = await runtime.readTerminal(terminal, { screen: true, limit: 1 })
              if (screen.source !== 'screen' || (screen.draft ?? '') !== (started ? text : '')) {
                throw new Error('terminal_chat_draft_changed')
              }
              started = true
            }
          })
          if (!result.accepted && result.bytesWritten === 0) {
            return false
          }
          if (!result.accepted || result.writeSettlement?.outcome === 'unverifiable') {
            throw new Error('terminal_chat_delivery_unknown')
          }
          return true
        } catch (error) {
          if (!started) {
            return false
          }
          throw error
        }
      }
    )
    let timer: ReturnType<typeof setInterval> | undefined
    const wake = () => {
      const pending = journal.queuedMessages
        .list()
        .some((card) => card.state === 'waiting' || card.state === 'returned')
      if (!pending) {
        clearInterval(timer)
        timer = undefined
      }
      if (pending && !timer) {
        timer = setInterval(() => {
          void queue.drain().catch((error: unknown) => {
            if (
              error instanceof Error &&
              /terminal_(?:gone|exited|handle_stale|not_writable)/.test(error.message)
            ) {
              runtime.cleanupSubscription(`nativeChatTerminalQueue:${terminal}`)
            }
          })
        }, 500)
        timer.unref()
      }
    }
    const unobserve = journal.observeCommits(wake)
    wake()
    runtime.registerSubscriptionCleanup(`nativeChatTerminalQueue:${terminal}`, () => {
      clearInterval(timer)
      unobserve()
      owned.delete(terminal)
      void journal.close()
    })
    return queue
  })()
  owned.set(terminal, opening)
  try {
    return await opening
  } catch (error) {
    owned.delete(terminal)
    throw error
  }
}

export const NATIVE_CHAT_TERMINAL_QUEUE_METHODS = [
  defineMethod({
    name: 'nativeChat.terminalQueue',
    permission: 'workspace',
    params: NativeChatTerminalQueueRequest,
    handler: async ({ terminal, action }, { runtime }) => {
      const queue = await terminalQueue(runtime, terminal)
      if (action.type === 'enqueue') {
        await queue.enqueue(action.messageId, action.text)
      }
      if (action.type === 'delete') {
        await queue.cancel(action.messageIds)
      }
      if (action.type === 'edit') {
        await queue.journal.queuedMessages.hold({
          messageIds: [action.messageId],
          reason: 'editing'
        })
      }
      return queue.snapshot()
    }
  })
]
