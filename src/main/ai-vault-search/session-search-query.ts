import type SyncDatabase from '../sqlite/sync-database'
import type {
  AiVaultSearchArgs,
  AiVaultSearchHit,
  AiVaultSearchRoute
} from '../../shared/ai-vault-search-types'
import {
  AI_VAULT_SEARCH_LIMIT_DEFAULT,
  AI_VAULT_SEARCH_LIMIT_MAX
} from '../../shared/ai-vault-search-types'
import type { AiVaultAgent } from '../../shared/ai-vault-types'
import {
  andExpression,
  orExpression,
  phraseExpression,
  planSessionSearchQuery,
  type SessionSearchQueryPlan
} from './session-search-query-planner'
import { isCollapsibleContentHash } from './session-search-content-hash'
import { SessionSearchTypoRepair } from './session-search-typo-repair'
import { sessionRowFilter, type SessionRowFilter } from './session-search-row-filter'
import {
  hasAiVaultSearchQueryOperators,
  splitAiVaultSearchQuery
} from '../../shared/ai-vault-search-query-operators'

// Measured: user 3 / assistant 2 / tool 1 / identifiers 1 (MRR 0.503 vs 0.475 flat).
const FULL_WEIGHTS = '3.0, 2.0, 1.0, 1.0'
const CONVERSATION_WEIGHTS = '3.0, 2.0'
// Candidate messages fetched before rolling up to sessions; more does not help.
const MESSAGE_CANDIDATE_LIMIT = 600
// Subtracted per session: `0.02 · ln(1 + messages)`; slightly positive on both eval sets.
const LENGTH_PRIOR = 0.02
const SNIPPET_TOKENS = 12

type MessageRow = {
  rowid: number
  score: number
  session_row_id: number
  role: string
  ts: string | null
}

type SessionRow = {
  id: number
  agent: AiVaultAgent
  session_id: string
  file_path: string
  codex_home: string | null
  title: string
  cwd: string | null
  branch: string | null
  updated_at: string | null
  message_count: number
  resume_command: string
  content_hash: string | null
  content_hash_count: number
}

type ScoredSession = {
  session: SessionRow
  message: MessageRow
  score: number
  duplicateCount: number
}

/** One search pass: the caller's args plus everything the operators decided. */
type Retrieval = {
  args: AiVaultSearchArgs
  tier: 'full' | 'conversation'
  filter: SessionRowFilter
  /** Query text with `repo:` / `path:` operators removed; what FTS sees. */
  text: string
}

export type SessionSearchExecution = {
  hits: AiVaultSearchHit[]
  route: AiVaultSearchRoute
  repairedTerms?: string[]
}

export class SessionSearchQuery {
  private readonly typoRepair: SessionSearchTypoRepair

  constructor(private readonly db: SyncDatabase) {
    this.typoRepair = new SessionSearchTypoRepair(db)
  }

  execute(args: AiVaultSearchArgs): SessionSearchExecution {
    const split = splitAiVaultSearchQuery(args.query)
    const retrieval: Retrieval = {
      args,
      tier: args.tier ?? 'full',
      filter: sessionRowFilter(args, split),
      text: split.text
    }
    const plan = planSessionSearchQuery(retrieval.text)
    if (plan.terms.length === 0) {
      // Operators with no free text still name a scope, so answer with the
      // newest sessions inside it rather than nothing.
      const hits = hasAiVaultSearchQueryOperators(split) ? this.recent(retrieval) : []
      return { hits, route: 'or' }
    }
    const exact = this.retrieveLiteral(plan, retrieval.tier)
    if (exact) {
      return { hits: this.rollUp(exact.rows, retrieval), route: exact.route }
    }
    // Why: repair runs before the OR fallback, not after it fails; a typo next
    // to a common word would otherwise be masked by the common word's hits.
    const repaired = this.repair(plan)
    const effective = repaired ?? plan
    const literal = repaired ? this.retrieveLiteral(repaired, retrieval.tier) : null
    const result = literal ?? {
      rows: this.match(orExpression(effective.terms), retrieval.tier),
      route: 'or' as const
    }
    return {
      hits: this.rollUp(result.rows, retrieval),
      route: repaired ? (`typo+${result.route}` as AiVaultSearchRoute) : result.route,
      ...(repaired ? { repairedTerms: repaired.body } : {})
    }
  }

  /** Operator-only queries: newest sessions the constraints allow, no evidence. */
  private recent(retrieval: Retrieval): AiVaultSearchHit[] {
    const { conditions, values } = retrieval.filter
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    return (
      this.db
        .prepare(
          `SELECT * FROM sessions ${where} ORDER BY updated_at DESC LIMIT ${resolveLimit(retrieval.args)}`
        )
        .all(...values) as SessionRow[]
    ).map((session) => ({
      ...sessionFields(session),
      score: 0,
      evidence: { role: 'unknown' as const, timestamp: null, snippet: '' }
    }))
  }

  private repair(plan: SessionSearchQueryPlan): SessionSearchQueryPlan | null {
    let changed = false
    const body = plan.body.map((term) => {
      const fix = this.typoRepair.correct(term)
      if (fix && fix !== term.toLowerCase()) {
        changed = true
        return fix
      }
      return term
    })
    return changed ? planSessionSearchQuery(body.join(' ')) : null
  }

  /** Phrase, then AND, for literal-looking queries; null when neither matches. */
  private retrieveLiteral(
    plan: SessionSearchQueryPlan,
    tier: 'full' | 'conversation'
  ): { rows: MessageRow[]; route: 'phrase' | 'and' } | null {
    if (!plan.literal || plan.body.length === 0) {
      return null
    }
    // A one-token literal (`resolveTerminalPath`, `src/a/b.ts`) is its own
    // phrase: the tokenizer keeps it whole, so the exact token is the cheap,
    // precise first try before the identifier pieces fan out over OR.
    const phrase = this.match(phraseExpression(plan.body), tier)
    if (phrase.length > 0) {
      return { rows: phrase, route: 'phrase' }
    }
    if (plan.body.length < 2) {
      return null
    }
    const and = this.match(andExpression(plan.body), tier)
    return and.length > 0 ? { rows: and, route: 'and' } : null
  }

  private match(expression: string, tier: 'full' | 'conversation'): MessageRow[] {
    const table = tier === 'full' ? 'messages_fts' : 'conversation_fts'
    const weights = tier === 'full' ? FULL_WEIGHTS : CONVERSATION_WEIGHTS
    try {
      // Why: FTS5 aux functions (bm25, snippet) take the table name, never an alias.
      return this.db
        .prepare(
          `SELECT ${table}.rowid AS rowid, -bm25(${table}, ${weights}) AS score,
             m.session_row_id, m.role, m.ts
           FROM ${table} JOIN messages m ON m.id = ${table}.rowid
           WHERE ${table} MATCH ? ORDER BY score DESC LIMIT ${MESSAGE_CANDIDATE_LIMIT}`
        )
        .all(expression) as MessageRow[]
    } catch {
      // A term the tokenizer rejects outright (e.g. only punctuation) is a miss, not a fault.
      return []
    }
  }

  private rollUp(rows: MessageRow[], retrieval: Retrieval): AiVaultSearchHit[] {
    const best = new Map<number, MessageRow>()
    for (const row of rows) {
      const current = best.get(row.session_row_id)
      if (!current || row.score > current.score) {
        best.set(row.session_row_id, row)
      }
    }
    if (best.size === 0) {
      return []
    }
    const sessions = this.loadSessions([...best.keys()], retrieval.filter)
    const scored = collapseForks(
      sessions.map((session) => {
        const message = best.get(session.id)!
        return {
          session,
          message,
          score: message.score - LENGTH_PRIOR * Math.log(1 + session.message_count),
          duplicateCount: 1
        }
      })
    )
    scored.sort((left, right) =>
      retrieval.args.sort === 'newest'
        ? (right.session.updated_at ?? '').localeCompare(left.session.updated_at ?? '')
        : right.score - left.score
    )
    const table = retrieval.tier === 'full' ? 'messages_fts' : 'conversation_fts'
    return scored
      .slice(0, resolveLimit(retrieval.args))
      .map(({ session, message, score, duplicateCount }) => ({
        ...sessionFields(session),
        score,
        ...(duplicateCount > 1 ? { duplicateCount } : {}),
        evidence: {
          role: message.role as AiVaultSearchHit['evidence']['role'],
          timestamp: message.ts,
          snippet: this.snippet(table, message.rowid, retrieval.text)
        }
      }))
  }

  private snippet(table: string, rowid: number, query: string): string {
    const expression = orExpression(planSessionSearchQuery(query).terms)
    try {
      // Why: a bound `rowid = ?` or `rowid IN (?)` next to MATCH is silently
      // ignored by the FTS5 planner (it returns the first match); only the
      // subselect form is honoured. Column -1 picks whichever column matched.
      const row = this.db
        .prepare(
          `SELECT snippet(${table}, -1, '[', ']', '…', ${SNIPPET_TOKENS}) AS s
           FROM ${table} WHERE ${table} MATCH ? AND rowid IN (SELECT ?)`
        )
        .get(expression, rowid) as { s: string } | undefined
      return row?.s ?? ''
    } catch {
      return ''
    }
  }

  private loadSessions(ids: number[], filter: SessionRowFilter): SessionRow[] {
    const conditions = [`id IN (${ids.map(() => '?').join(',')})`, ...filter.conditions]
    return this.db
      .prepare(`SELECT * FROM sessions WHERE ${conditions.join(' AND ')}`)
      .all(...ids, ...filter.values) as SessionRow[]
  }
}

function resolveLimit(args: AiVaultSearchArgs): number {
  return Math.min(args.limit ?? AI_VAULT_SEARCH_LIMIT_DEFAULT, AI_VAULT_SEARCH_LIMIT_MAX)
}

function sessionFields(session: SessionRow): Omit<AiVaultSearchHit, 'score' | 'evidence'> {
  return {
    agent: session.agent,
    sessionId: session.session_id,
    filePath: session.file_path,
    codexHome: session.codex_home,
    title: session.title,
    cwd: session.cwd,
    branch: session.branch,
    updatedAt: session.updated_at,
    messageCount: session.message_count,
    resumeCommand: session.resume_command
  }
}

/**
 * Folds forked copies of one conversation into a single hit: same opening
 * prefix, newest `updated_at` wins, the rest become `duplicateCount`. Done here
 * and not at write time so index rows stay per file (cursors and deletes).
 */
function collapseForks(scored: ScoredSession[]): ScoredSession[] {
  const groups = new Map<string, ScoredSession[]>()
  for (const entry of scored) {
    const { content_hash: hash, content_hash_count: count, id } = entry.session
    const key = isCollapsibleContentHash(hash, count) ? `hash:${hash}` : `session:${id}`
    const group = groups.get(key)
    if (group) {
      group.push(entry)
    } else {
      groups.set(key, [entry])
    }
  }
  const collapsed: ScoredSession[] = []
  for (const group of groups.values()) {
    if (group.length === 1) {
      collapsed.push(group[0]!)
      continue
    }
    const winner = group.reduce((best, entry) => (isNewer(entry, best) ? entry : best))
    collapsed.push({ ...winner, duplicateCount: group.length })
  }
  return collapsed
}

function isNewer(entry: ScoredSession, best: ScoredSession): boolean {
  const order = (entry.session.updated_at ?? '').localeCompare(best.session.updated_at ?? '')
  return order === 0 ? entry.score > best.score : order > 0
}
