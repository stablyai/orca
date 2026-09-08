import {
  MobileWebBridgeClientError,
  type MobileWebBridgeClient
} from '../../../src/mobile-web/src/mobile-web-bridge-client'
import type { MobileNativeChatSendOutcome } from './mobile-native-chat-send'
import {
  MOBILE_NATIVE_CHAT_MIN_WRITE_TIMEOUT_MS,
  openMobileNativeChatSendBudget
} from './mobile-native-chat-send'
import {
  clearMobileNativeChatInputStale,
  isMobileNativeChatInputStale
} from './mobile-native-chat-stale-input'
import type {
  HostSessionNativeChatOperations,
  HostSessionNativeChatTarget
} from './host-session-native-chat-operations'

export function webHostSessionNativeChatOperations(
  client: MobileWebBridgeClient
): HostSessionNativeChatOperations {
  return {
    // The hosted page never pre-gates: the host owns eligibility and each
    // transcript read validates its own execution provider.
    readability() {
      return Promise.resolve(true)
    },
    subscribe(target, limit, onEvent, onError) {
      const payload = bridgeTarget(target, { limit })
      if (!target.terminalId) {
        queueMicrotask(onError)
        return () => {}
      }
      const subscription = client.nativeChat.subscribeForTab(
        target.terminalId,
        payload,
        onEvent,
        onError
      )
      void subscription.ready.catch(() => {})
      return subscription.unsubscribe
    },
    async read(target, limit, beforeOffset) {
      try {
        const payload = bridgeTarget(target, {
          limit,
          ...(beforeOffset === undefined ? {} : { beforeOffset })
        })
        if (!target.terminalId) {
          return { error: 'Missing terminal identity' }
        }
        return await client.nativeChat.readForTab(payload, target.terminalId)
      } catch {
        return { error: 'Transcript read failed' }
      }
    },
    async sendMessage(target, text, deadline, clearInputFirst, resolvedLaunchDraft, typeCommand) {
      const budget = bridgeBudget(deadline)
      if (!budget) {
        return 'rejected'
      }
      try {
        return (
          await client.nativeChat.sendMessage(
            bridgeTarget(target, {
              text,
              deadline: budget.deadline,
              ...(clearInputFirst ? { clearInputFirst: true } : {}),
              ...(resolvedLaunchDraft ? { resolvedLaunchDraft } : {}),
              ...(typeCommand ? { typeCommand: true } : {})
            }),
            { timeoutMs: budget.timeoutMs },
            target.terminalId ?? undefined
          )
        ).outcome
      } catch (error) {
        return bridgeMutationFailureOutcome(error)
      }
    },
    async prepareCommit(target, deadline) {
      if (!target.terminalId || !isMobileNativeChatInputStale(target.terminalId)) {
        return true
      }
      const budget = bridgeBudget(deadline)
      if (!budget) {
        return false
      }
      try {
        const result = await client.nativeChat.prepareCommit(
          bridgeTarget(target, { deadline: budget.deadline }),
          { timeoutMs: budget.timeoutMs },
          target.terminalId ?? undefined
        )
        if (result.prepared) {
          clearMobileNativeChatInputStale(target.terminalId)
        }
        return result.prepared
      } catch {
        return false
      }
    },
    async respond(target, text, enter, deadline) {
      const budget = bridgeBudget(deadline)
      if (!budget) {
        return 'rejected'
      }
      try {
        return (
          await client.nativeChat.respond(
            bridgeTarget(target, { text, enter, deadline: budget.deadline }),
            { timeoutMs: budget.timeoutMs },
            target.terminalId ?? undefined
          )
        ).outcome
      } catch (error) {
        return bridgeMutationFailureOutcome(error)
      }
    },
    async stop(target, deadline) {
      const budget = bridgeBudget(deadline)
      if (!budget) {
        return 'rejected'
      }
      try {
        return (
          await client.nativeChat.stop(
            bridgeTarget(target, { deadline: budget.deadline }),
            {
              timeoutMs: budget.timeoutMs
            },
            target.terminalId ?? undefined
          )
        ).outcome
      } catch (error) {
        return bridgeMutationFailureOutcome(error)
      }
    },
    async attachImage(target, source) {
      const result = await client.nativeChat.attachImage(bridgeTarget(target, { source }))
      if (result.status === 'accepted') {
        if (!result.attachment) {
          throw new Error('Accepted image attachment is missing')
        }
        return { status: 'accepted', attachment: result.attachment }
      }
      return { status: result.status }
    },
    async pasteImages(target, references, deadline, followedByText) {
      const budget = bridgeBudget(deadline)
      if (!budget) {
        return false
      }
      try {
        return (
          await client.nativeChat.pasteImages(
            bridgeTarget(target, {
              references: [...references],
              deadline: budget.deadline,
              ...(followedByText ? { followedByText } : {})
            }),
            { timeoutMs: budget.timeoutMs }
          )
        ).pasted
      } catch {
        return false
      }
    },
    async releaseImages(target, references) {
      await client.nativeChat.releaseImages(bridgeTarget(target, { references: [...references] }))
    },
    async searchFiles(target, query) {
      return (
        await client.nativeChat.fileSearch(
          bridgeTarget(target, { query }),
          target.terminalId ?? undefined
        )
      ).paths
    },
    async openFile(target, pathText) {
      try {
        await client.nativeChat.openFile(
          bridgeTarget(target, { pathText }),
          target.terminalId ?? undefined
        )
      } catch {
        // File links are best-effort in both native and hosted chat.
      }
    }
  }
}

function bridgeMutationFailureOutcome(error: unknown): MobileNativeChatSendOutcome {
  if (!(error instanceof MobileWebBridgeClientError)) {
    return 'rejected'
  }
  return error.code === 'timeout' ||
    error.code === 'cancelled' ||
    error.code === 'invalid_message' ||
    error.code === 'internal' ||
    error.code === 'host_error'
    ? 'unknown'
    : 'rejected'
}

function bridgeTarget<T extends object>(target: HostSessionNativeChatTarget, value: T) {
  return {
    workspaceId: target.workspaceId,
    sessionId: target.sessionId,
    ...value
  }
}

function bridgeBudget(deadline?: number): { deadline: number; timeoutMs: number } | null {
  const resolvedDeadline = deadline ?? openMobileNativeChatSendBudget()
  const timeoutMs = resolvedDeadline - Date.now()
  return timeoutMs < MOBILE_NATIVE_CHAT_MIN_WRITE_TIMEOUT_MS
    ? null
    : { deadline: resolvedDeadline, timeoutMs }
}
