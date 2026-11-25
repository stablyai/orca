import type { AgentSessionRecordStore } from '../../runtime/agent-session/records/agent-session-record-store'
import type { AgentSessionInstructionPolicy } from '../../../shared/agent-session/agent-session-instruction-policy'
import { sameInstructionBaseline } from '../../../shared/agent-session/agent-session-instruction-policy'
import type {
  StructuredAgentSessionTurnContext,
  StructuredAgentSessionTurnContextPlan
} from './structured-agent-session-turn-context'
import type { StructuredAgentSessionLogger } from './host/structured-agent-session-logger'
import { withNeverThrowingLogger } from './host/structured-agent-session-logger'
import type { StructuredAgentSessionHostDeps } from './host/structured-agent-session-host-types'

export function withInstructionBaselineHost(
  deps: StructuredAgentSessionHostDeps,
  track: <T>(work: Promise<T>) => Promise<T>
): StructuredAgentSessionHostDeps {
  deps = withNeverThrowingLogger(deps)
  return {
    ...deps,
    turnContext: withInstructionBaselinePersistence(
      deps.turnContext,
      deps.store,
      track,
      deps.logger
    )
  }
}

export function withInstructionBaselinePersistence(
  context: StructuredAgentSessionTurnContext | undefined,
  store: Pick<AgentSessionRecordStore, 'getRecord' | 'updateRecord'>,
  track: <T>(work: Promise<T>) => Promise<T>,
  logger: StructuredAgentSessionLogger
): StructuredAgentSessionTurnContext | undefined {
  if (!context?.instructionBaseline) {
    return context
  }
  const save = async (sessionId: string, expected: AgentSessionInstructionPolicy | undefined) => {
    const baseline = context.instructionBaseline?.(sessionId)
    if (
      !baseline ||
      expected?.state !== 'delivered' ||
      sameInstructionBaseline(store.getRecord(sessionId)?.instructionPolicy?.baseline, baseline)
    ) {
      return
    }
    await store.updateRecord(sessionId, { kind: 'instruction-baseline', expected, baseline })
  }
  const accepted = (
    sessionId: string,
    plan: StructuredAgentSessionTurnContextPlan | null,
    expected: AgentSessionInstructionPolicy | undefined
  ): StructuredAgentSessionTurnContextPlan | null => {
    if (!plan || expected?.state !== 'delivered') {
      return plan
    }
    return {
      ...plan,
      given: async (receipt) => {
        await plan.given(receipt)
        await save(sessionId, expected)
      }
    }
  }
  return {
    ...context,
    plan: async (sessionId, message, held) => {
      const expected = store.getRecord(sessionId)?.instructionPolicy
      return accepted(sessionId, await context.plan(sessionId, message, held), expected)
    },
    ...(context.launchUpdate
      ? {
          launchUpdate: async (sessionId: string, held?: string | null) => {
            const expected = store.getRecord(sessionId)?.instructionPolicy
            return accepted(sessionId, await context.launchUpdate!(sessionId, held), expected)
          }
        }
      : {}),
    ...(context.turnEnded
      ? {
          turnEnded: (
            ...args: Parameters<NonNullable<StructuredAgentSessionTurnContext['turnEnded']>>
          ) => {
            const expected = store.getRecord(args[0])?.instructionPolicy
            if (expected?.state !== 'delivered') {
              return context.turnEnded!(...args)
            }
            return track(
              Promise.resolve(context.turnEnded!(...args))
                .then(() =>
                  args[4]?.isCurrent?.() === false ? undefined : save(args[0], expected)
                )
                .catch((error: unknown) =>
                  logger.warn('saving the delivered instruction baseline failed', {
                    scope: 'instruction-baseline',
                    sessionId: args[0],
                    error
                  })
                )
            )
          }
        }
      : {})
  }
}
