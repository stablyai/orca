import type { StructuredAgentSessionLiveOptions } from '../../../native-chat/agent-session-wire/options/structured-agent-session-option-models'
import type { AgentSessionOptionsResult } from '../../../../shared/agent-session/options/protocol/agent-session-options-result'
import type { CodexSession } from '../session-lifecycle/codex-structured-session-state'
import { isCodexTurnOptionKey } from '../turns/codex-turn-option-keys'
import { AgentSessionOptionRejectedError } from '../../../native-chat/agent-session-wire/options/structured-agent-session-option-error'
import { codexFastServiceTier } from './codex-structured-service-tier'
import { codexServiceTierForFastMode } from '../../../../shared/agent-session/options/codex-message-compiler'
import {
  composeCodexSessionOptionCatalog,
  type CodexSessionOptionCatalog
} from './codex-structured-model-catalog'
import { codexSessionCapabilities } from './codex-structured-catalog-entry'

export function restoredCodexSessionOptions(
  options: Readonly<Record<string, string>> | undefined
): Map<string, string> {
  return new Map(Object.entries(options ?? {}).filter(([key]) => isCodexTurnOptionKey(key)))
}

/** Report current child evidence together with the saved next-turn intent. */
export function reportedCodexSessionOptions(
  session: CodexSession
): AgentSessionOptionsResult['current'] {
  const model = session.options.get('model') ?? session.reportedOptions.model ?? ''
  const effort =
    session.options.get('effort') ??
    (model === session.reportedOptions.model ? session.reportedOptions.effort : undefined)
  const serviceTier = session.options.get('serviceTier')
  return {
    model,
    reportedPermissionMode: session.reportedOptions.reportedPermissionMode,
    ...(effort ? { effort } : {}),
    ...(serviceTier ? { serviceTier } : {})
  }
}

function composeLiveCodexCatalog(
  session: CodexSession,
  listing: ReturnType<typeof codexSessionCapabilities>
): CodexSessionOptionCatalog {
  const { model, effort, serviceTier } = session.appliedTurnOptions ?? {}
  const catalog = composeCodexSessionOptionCatalog(listing, {
    current: {
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(serviceTier ? { serviceTier } : {})
    },
    ...(serviceTier ? { reportedServiceTier: serviceTier, reportedServiceTierKnown: true } : {})
  })
  return {
    ...catalog,
    current: {
      ...catalog.current,
      reportedPermissionMode: session.reportedOptions.reportedPermissionMode
    },
    fastModeSupport: listing.fastModeSupport
  }
}

/** Current options compose only from the installed catalog and exact-child facts. */
export async function readLiveCodexSessionOptions(
  session: CodexSession,
  _timeoutMs: number | undefined
): Promise<StructuredAgentSessionLiveOptions> {
  return composeLiveCodexCatalog(session, codexSessionCapabilities(session))
}

export async function applyCodexStructuredSessionOption(
  session: CodexSession,
  key: string,
  value: string
): Promise<Readonly<Record<string, string>>> {
  try {
    return applyValidatedCodexStructuredSessionOption(session, key, value)
  } catch (error) {
    throw new AgentSessionOptionRejectedError(error)
  }
}

function applyValidatedCodexStructuredSessionOption(
  session: CodexSession,
  requestedKey: string,
  requestedValue: string
): Readonly<Record<string, string>> {
  if (!isCodexTurnOptionKey(requestedKey) && requestedKey !== 'fastMode') {
    throw new Error(`codex has no session option named ${requestedKey}`)
  }
  const key = requestedKey === 'fastMode' ? 'serviceTier' : requestedKey
  const value =
    requestedKey === 'fastMode'
      ? codexServiceTierOfFastMode(
          requestedValue,
          codexSessionCapabilities(session).models.find(
            (row) => row.id === (session.options.get('model') ?? session.reportedOptions.model)
          )
        )
      : requestedValue
  session.options.set(key, value)
  return Object.fromEntries(session.options)
}

/** Older clients' boolean uses the native Fast encoding when no menu names a tier. */
export function codexServiceTierOfFastMode(
  encoded: string,
  model: Parameters<typeof codexFastServiceTier>[0]
): string {
  return codexServiceTierForFastMode(encoded, codexFastServiceTier(model))
}
