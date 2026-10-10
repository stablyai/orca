import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import {
  fetchCodexModelCatalogListing,
  type CodexModelCatalogListing
} from './codex-structured-model-catalog'
import type { CodexSession } from './codex-structured-session-state'
import { reconcileCodexFastModeOption } from './codex-structured-fast-mode'

type BackgroundCatalogInput = {
  session: CodexSession
  sessionId: string
  sessions: ReadonlyMap<string, CodexSession>
  timeoutMs: number | undefined
  logger: StructuredAgentSessionLogger | undefined
}

/** Turns read tiers from the store; only a legacy saved tier needs migrating here. */
function applyListing(session: CodexSession, listing: CodexModelCatalogListing): void {
  if (!session.options.has('serviceTier')) {
    return
  }
  const model =
    session.options.get('model') ??
    session.reportedOptions.model ??
    listing.models.find((entry) => entry.isDefault)?.id ??
    listing.models[0]?.id ??
    ''
  reconcileCodexFastModeOption(session, {
    fastModeTierByModel: listing.fastModeTierByModel,
    currentFastMode: undefined,
    model,
    modelFastModeSupport: undefined
  })
}

async function refresh(input: BackgroundCatalogInput): Promise<void> {
  const { session, sessionId, sessions } = input
  const access = session.catalogAccess
  const store = access?.store
  const fingerprint = access?.fingerprint
  const prior = fingerprint ? store?.get(fingerprint) : undefined
  const model = session.options.get('model') ?? session.reportedOptions.model
  const needsTier =
    (session.options.get('fastMode') === 'true' || session.options.has('serviceTier')) &&
    (!model || !prior?.fastModeTierByModel[model])
  if (
    fingerprint &&
    store &&
    (store.hasActiveFailure(fingerprint) || (prior && !store.isStale(prior) && !needsTier))
  ) {
    return
  }
  const isCurrent = (): boolean => sessions.get(sessionId) === session && !session.ended
  try {
    const listing = await fetchCodexModelCatalogListing({
      connection: session.connection,
      timeoutMs: input.timeoutMs,
      deadlineMs: Math.min(input.timeoutMs ?? 30_000, 30_000)
    })
    if (listing.models.length === 0) {
      throw new Error('codex app-server returned no available models')
    }
    if (!isCurrent()) {
      return
    }
    const latest = fingerprint ? store?.get(fingerprint) : undefined
    if (latest && latest !== prior) {
      applyListing(session, {
        models: latest.models,
        fastModeTierByModel: new Map(Object.entries(latest.fastModeTierByModel))
      })
      return
    }
    if (fingerprint && store) {
      // `model/list` is Codex's account-level listing, the one its probe also runs.
      store.recordSuccess(
        fingerprint,
        'codex',
        {
          models: listing.models,
          fastModeTierByModel: listing.fastModeTierByModel,
          origin: 'live-session'
        },
        'discovery'
      )
    }
    applyListing(session, listing)
  } catch (error) {
    if (!isCurrent()) {
      return
    }
    if (fingerprint && store && store.get(fingerprint) === prior) {
      store.recordFailure(fingerprint, error instanceof Error ? error.message : String(error))
    }
    input.logger?.warn('Codex model catalog refresh failed', {
      scope: 'codex-background-catalog',
      sessionId,
      error
    })
  }
}

/** Catalog work begins after ownership and never joins a chat action. */
export function startBackgroundCodexCatalogRefresh(input: BackgroundCatalogInput): void {
  void refresh(input).catch((error: unknown) => {
    try {
      input.logger?.warn('Codex model catalog refresh failed', {
        scope: 'codex-background-catalog',
        sessionId: input.sessionId,
        error
      })
    } catch {
      // Reporting must never reject an unawaited task.
    }
  })
}
