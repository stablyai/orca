import { randomUUID } from 'node:crypto'
import type { StructuredAgentSessionConversationLifetimeHost } from './structured-agent-session-conversation-lifetime-host'
import {
  AgentSessionRefusalError,
  agentSessionRefusalError
} from '../../../shared/agent-session-wire-refusals'
import { AGENT_SESSION_NOT_ATTACHED } from './structured-agent-session-mutation-admission'
import type {
  AgentSessionSwitchDeadline,
  AgentSessionSwitchResult,
  AgentSessionSwitchReceipt
} from '../../../shared/agent-session-switch-execution'

// Commands outlive the read handle they may close themselves.
export type SwitchCommand = {
  invocationId: string
  generation: string
  settled: boolean
  present: (view: Extract<AgentSessionSwitchResult, { status: 'present' }>) => void
  presentation: Promise<AgentSessionSwitchResult>
  shown: Promise<boolean>
  acknowledge: (shown: boolean) => void
  opened: Promise<AgentSessionSwitchResult>
  openedResult: (result: AgentSessionSwitchResult) => void
  deadline: AgentSessionSwitchDeadline
  revokeOnSend: boolean
  retain?: () => Promise<void>
  retentionAllowed: boolean
  completion: Promise<AgentSessionSwitchResult>
  physical?: Promise<void>
  cleanupTimer?: ReturnType<typeof setTimeout>
}

export function selectStructuredSessionSwitchCommand(args: {
  host: StructuredAgentSessionConversationLifetimeHost
  commands: Map<string, SwitchCommand>
  isDisposed: () => boolean
  id: string
  invocationId: string
  deadline: AgentSessionSwitchDeadline
  run: () => Promise<AgentSessionSwitchResult>
  revokeOnSend: boolean
  phase?: { observe?: boolean; receipt?: AgentSessionSwitchReceipt }
  onRetained?: (check: () => void) => Promise<void>
  allowUncreated: boolean
}): SwitchCommand {
  const {
    host,
    commands,
    isDisposed,
    id,
    invocationId,
    deadline,
    run,
    revokeOnSend,
    phase,
    onRetained,
    allowUncreated
  } = args
  const { sessions, serialize } = host
  const deps = () => host.context().deps
  deadline.check()
  const prior = commands.get(id)
  if (prior) {
    if (prior.invocationId !== invocationId && !prior.settled) {
      throw agentSessionRefusalError('agent_session_operation_invalid', {
        reason: 'handoffInFlight'
      })
    }
    if (prior.invocationId === invocationId) {
      return prior
    }
    prior.retentionAllowed = false
    clearTimeout(prior.cleanupTimer)
    prior.deadline.revoke()
    commands.delete(id)
  }
  if (phase?.observe || phase?.receipt) {
    throw agentSessionRefusalError('agent_session_operation_unknown', {
      reason: 'outcomeUnknown'
    })
  }
  const session = sessions.get(id)
  if (!deps().store.getRecord(id) && !allowUncreated) {
    throw new AgentSessionRefusalError(AGENT_SESSION_NOT_ATTACHED)
  }
  let present!: (view: Extract<AgentSessionSwitchResult, { status: 'present' }>) => void
  let acknowledge!: (shown: boolean) => void
  let openedResult!: (result: AgentSessionSwitchResult) => void
  const presentation = new Promise<Extract<AgentSessionSwitchResult, { status: 'present' }>>(
    (resolve) => {
      present = resolve
    }
  )
  const shown = new Promise<boolean>((resolve) => {
    acknowledge = resolve
  })
  const opened = new Promise<AgentSessionSwitchResult>((resolve) => {
    openedResult = resolve
  })
  const command: SwitchCommand = {
    invocationId,
    generation: randomUUID(),
    settled: false,
    deadline,
    revokeOnSend,
    retentionAllowed: true,
    retain: async () => {
      const check = () => {
        if (!command.retentionAllowed || commands.get(id) !== command) {
          throw agentSessionRefusalError('agent_session_operation_expired', {
            reason: 'operationExpired'
          })
        }
      }
      check()
      await onRetained?.(check)
    },
    present,
    acknowledge,
    presentation,
    shown,
    opened,
    openedResult,
    completion: Promise.resolve().then(async () => {
      if (deps().store.getRecord(id)) {
        await serialize(id, async () => {
          deadline.check()
          const opened = await host.open(id)
          deadline.check()
          if (opened) {
            opened.switchCommand = command
          }
        })
      }
      try {
        const result = await run()
        if (revokeOnSend && (result.status === 'refused' || result.status === 'uncertain')) {
          await command.retain?.()
        }
        return result
      } catch (error) {
        if (revokeOnSend) {
          await command.retain?.().catch(() => {})
        }
        throw error
      }
    })
  }
  commands.set(id, command)
  const retainOnExpiry = () => {
    if (revokeOnSend) {
      void command.retain?.().catch(() => {})
    }
  }
  deadline.signal.addEventListener('abort', retainOnExpiry, { once: true })
  if (session) {
    session.switchCommand = command
  }
  host.context().publishStatus?.(id)
  void command.completion
    .finally(() => {
      command.settled = true
      deadline.dispose()
      for (const [key, current] of commands) {
        if (current === command && sessions.get(key)?.switchCommand === command) {
          delete sessions.get(key)!.switchCommand
        }
      }
      host.context().publishStatus?.(id)
      if (isDisposed()) {
        return
      }
      command.cleanupTimer = setTimeout(
        () => {
          void Promise.resolve(command.physical).then(() => {
            command.retentionAllowed = false
            deadline.signal.removeEventListener('abort', retainOnExpiry)
            for (const [key, current] of commands) {
              if (current === command) {
                commands.delete(key)
              }
            }
          })
        },
        Math.max(1, deadline.remaining())
      )
      command.cleanupTimer.unref?.()
    })
    .catch(() => {})
  return command
}
