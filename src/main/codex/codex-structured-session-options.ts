import type { StructuredAgentSessionLiveOptions } from '../native-chat/agent-session-wire/structured-agent-session-option-models'
import type { AgentSessionOptionsResult } from '../../shared/agent-session-wire'
import type { CodexSession } from './codex-structured-session-state'
import { isCodexTurnOptionKey } from './codex-structured-turn-start'
import { AgentSessionOptionRejectedError } from '../native-chat/agent-session-wire/structured-agent-session-option-error'
import { decodeStructuredAgentSessionOptionValue } from '../../shared/structured-agent-session-option-codec'
import { CODEX_DEFAULT_SERVICE_TIER, codexFastServiceTier } from './codex-structured-service-tier'
import {
  composeCodexSessionOptionCatalog,
  type CodexSessionOptionCatalog
} from './codex-structured-model-catalog'
import { codexSessionCapabilities } from './codex-structured-catalog-entry'
export { codexAcquireCatalogListing } from './codex-structured-catalog-entry'

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

export type { CodexSessionOptionCatalog } from './codex-structured-model-catalog'

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
  const fastMode = decodeStructuredAgentSessionOptionValue('fastMode', encoded)
  if (typeof fastMode !== 'boolean') {
    throw new Error('codex fast mode must be encoded as true or false')
  }
  return fastMode ? (codexFastServiceTier(model) ?? 'fast') : CODEX_DEFAULT_SERVICE_TIER
}
