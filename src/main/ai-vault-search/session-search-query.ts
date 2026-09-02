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
    const plan = planSessionSearchQuery(args.query)
    if (plan.terms.length === 0) {
      return { hits: [], route: 'or' }
    }
    const tier = args.tier ?? 'full'
    const exact = this.retrieveLiteral(plan, tier)
    if (exact) {
      return { hits: this.rollUp(exact.rows, args, tier), route: exact.route }
    }
    // Why: repair runs before the OR fallback, not after it fails; a typo next
    // to a common word would otherwise be masked by the common word's hits.
    const repaired = this.repair(plan)
    const effective = repaired ?? plan
    const literal = repaired ? this.retrieveLiteral(repaired, tier) : null
    const result = literal ?? {
      rows: this.match(orExpression(effective.terms), tier),
      route: 'or' as const
    }
    return {
      hits: this.rollUp(result.rows, args, tier),
      route: repaired ? (`typo+${result.route}` as AiVaultSearchRoute) : result.route,
      ...(repaired ? { repairedTerms: repaired.body } : {})
    }
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

  private rollUp(
    rows: MessageRow[],
    args: AiVaultSearchArgs,
    tier: 'full' | 'conversation'
  ): AiVaultSearchHit[] {
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
    const sessions = this.loadSessions([...best.keys()], args)
    const limit = Math.min(args.limit ?? AI_VAULT_SEARCH_LIMIT_DEFAULT, AI_VAULT_SEARCH_LIMIT_MAX)
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
      args.sort === 'newest'
        ? (right.session.updated_at ?? '').localeCompare(left.session.updated_at ?? '')
        : right.score - left.score
    )
    const table = tier === 'full' ? 'messages_fts' : 'conversation_fts'
    return scored.slice(0, limit).map(({ session, message, score, duplicateCount }) => ({
      agent: session.agent,
      sessionId: session.session_id,
      filePath: session.file_path,
      codexHome: session.codex_home,
      title: session.title,
      cwd: session.cwd,
      branch: session.branch,
      updatedAt: session.updated_at,
      messageCount: session.message_count,
      resumeCommand: session.resume_command,
      score,
      ...(duplicateCount > 1 ? { duplicateCount } : {}),
      evidence: {
        role: message.role as AiVaultSearchHit['evidence']['role'],
        timestamp: message.ts,
        snippet: this.snippet(table, message.rowid, args.query)
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

  private loadSessions(ids: number[], args: AiVaultSearchArgs): SessionRow[] {
    const conditions = [`id IN (${ids.map(() => '?').join(',')})`]
    const values: (string | number)[] = [...ids]
    if (args.agents && args.agents.length > 0) {
      conditions.push(`agent IN (${args.agents.map(() => '?').join(',')})`)
      values.push(...args.agents)
    }
    if (args.since) {
      conditions.push('updated_at >= ?')
      values.push(args.since)
    }
    if (args.scopePaths && args.scopePaths.length > 0) {
      conditions.push(`(${args.scopePaths.map(() => '(cwd = ? OR cwd LIKE ?)').join(' OR ')})`)
      for (const scope of args.scopePaths) {
        const trimmed = scope.replace(/[\\/]+$/, '')
        values.push(trimmed, `${trimmed}${trimmed.includes('\\') ? '\\' : '/'}%`)
      }
    }
    return this.db
      .prepare(`SELECT * FROM sessions WHERE ${conditions.join(' AND ')}`)
      .all(...values) as SessionRow[]
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
