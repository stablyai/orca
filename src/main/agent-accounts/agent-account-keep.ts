import type { AgentRunAccount, SetAgentKeptResult } from '../../shared/agent-run-account'
import { normalizeAgentProviderSession } from '../../shared/agent-session-resume'
import type { AgentRunAccountRow } from '../agent-hooks/server/server-run-account'
import type {
  CodexPaneAccountRecord,
  SetCodexPaneKeptResult
} from '../codex/codex-pane-account-registry'
import { isCodexPaneKeepable } from '../codex/codex-stale-pane-accounts'
import type { KeptAgentConversations } from './kept-agent-conversations'

export type { SetAgentKeptResult }

export type AgentKeepDeps = {
  getRow: (paneKey: string) => AgentRunAccountRow | null
  refresh: (paneKey: string) => AgentRunAccount | null
  withdraw: (paneKey: string) => void
  kept: Pick<KeptAgentConversations, 'keep' | 'release' | 'acceptsChanges'>
  getPtyIdForPaneKey: (paneKey: string) => string | undefined
  getPaneKeyForPty: (ptyId: string) => string | undefined
  readCodexRecord: (ptyId: string) => CodexPaneAccountRecord | null
  setCodexPaneKept: (ptyId: string, kept: boolean) => SetCodexPaneKeptResult
  keepStaleCodexPanes: (ptyIds: readonly string[]) => string[]
  now?: () => number
}

function keepConversation(
  deps: AgentKeepDeps,
  row: AgentRunAccountRow,
  provider: 'claude' | 'codex',
  accountId: string | null,
  kept: boolean
): void {
  const session = normalizeAgentProviderSession(row.providerSession)
  if (!session) {
    return
  }
  if (!kept) {
    deps.kept.release(provider, session.id)
    return
  }
  deps.kept.keep(provider, session.id, {
    lane: 'host',
    accountId,
    keptAt: (deps.now ?? Date.now)(),
    ...(session.transcriptPath ? { transcriptPath: session.transcriptPath } : {})
  })
}

/** Keeps or releases one local terminal agent on the account its row says it runs on. */
export function setAgentKept(
  deps: AgentKeepDeps,
  args: { paneKey: string; ptyId?: string; kept: boolean }
): SetAgentKeptResult {
  const row = deps.getRow(args.paneKey)
  const facet = row?.runAccount
  if (!row || !facet || row.connectionId !== null) {
    return { ok: false, reason: 'unknown-pane' }
  }
  const ptyId = deps.getPtyIdForPaneKey(row.paneKey)
  if (!args.kept) {
    return releaseAgent(deps, row, facet, ptyId)
  }
  if (args.ptyId !== undefined && args.ptyId !== ptyId) {
    return { ok: false, reason: 'unknown-pane' }
  }
  if (!deps.kept.acceptsChanges()) {
    return { ok: false, reason: 'read-only' }
  }
  if (facet.provider === 'codex') {
    const record = ptyId ? deps.readCodexRecord(ptyId) : null
    if (!ptyId || !record) {
      return { ok: false, reason: 'unknown-pane' }
    }
    if (!isCodexPaneKeepable(record)) {
      return { ok: false, reason: 'not-keepable' }
    }
    const result = deps.setCodexPaneKept(ptyId, args.kept)
    if (result === 'unavailable' || result === 'no-record') {
      return { ok: false, reason: result === 'unavailable' ? 'unavailable' : 'unknown-pane' }
    }
    keepConversation(deps, row, 'codex', record.accountId, args.kept)
  } else {
    if (!normalizeAgentProviderSession(row.providerSession)) {
      return { ok: false, reason: 'no-session' }
    }
    keepConversation(deps, row, 'claude', facet.accountId, args.kept)
  }
  const runAccount = deps.refresh(row.paneKey)
  return runAccount ? { ok: true, runAccount } : { ok: false, reason: 'unknown-pane' }
}

/** Needs no live terminal: a refused kept resume has none, and un-keeping is its way out. */
function releaseAgent(
  deps: AgentKeepDeps,
  row: AgentRunAccountRow,
  facet: AgentRunAccount,
  ptyId: string | undefined
): SetAgentKeptResult {
  // Why: an unreadable registry is not "no record"; only the release's own answer can tell them apart.
  const codexRelease =
    facet.provider === 'codex' && ptyId ? deps.setCodexPaneKept(ptyId, false) : 'no-record'
  if (codexRelease === 'unavailable') {
    return { ok: false, reason: 'unavailable' }
  }
  const listAcceptsChanges = deps.kept.acceptsChanges()
  // Why: a newer Orca's list drops a release; only a Codex pane's own launch record can still let go.
  if (!listAcceptsChanges && codexRelease === 'no-record') {
    return { ok: false, reason: 'read-only' }
  }
  if (listAcceptsChanges) {
    keepConversation(deps, row, facet.provider, facet.accountId, false)
  }
  const runAccount = deps.refresh(row.paneKey)
  if (runAccount?.mode === 'follow') {
    return { ok: true, runAccount }
  }
  // Why: with no process to observe, the stored facet still says kept; nothing honours it now.
  deps.withdraw(row.paneKey)
  return { ok: true, runAccount: null }
}

/** "Keep old account": keeps each pane that can be kept, and its current conversation. */
export function keepStaleCodexPanesAndConversations(
  deps: AgentKeepDeps,
  panes: readonly { ptyId: string; paneKey?: string }[]
): void {
  const keptPtyIds = new Set(deps.keepStaleCodexPanes(panes.map((pane) => pane.ptyId)))
  for (const pane of panes) {
    if (!keptPtyIds.has(pane.ptyId)) {
      continue
    }
    const paneKey =
      pane.paneKey && deps.getPtyIdForPaneKey(pane.paneKey) === pane.ptyId
        ? pane.paneKey
        : deps.getPaneKeyForPty(pane.ptyId)
    const row = paneKey ? deps.getRow(paneKey) : null
    const record = deps.readCodexRecord(pane.ptyId)
    if (!row || !record || row.agentType !== 'codex') {
      continue
    }
    keepConversation(deps, row, 'codex', record.accountId, true)
    deps.refresh(row.paneKey)
  }
}
