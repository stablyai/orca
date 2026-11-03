import { basename, join } from 'node:path'
import { readOpenCodeDatabase } from './session-scanner-opencode-sqlite-open'
import { asRecord } from './session-scanner-record-value'
import { extractString } from './session-scanner-values'

const SESSIONS_DB = 'sessions.db'
const SEPARATOR = '#'
const MAX_SUMMARY_DEPTH = 64

export function devinSessionsDbPathInStore(cliDir: string): string {
  return join(cliDir, SESSIONS_DB)
}

/** Names a database row, not a file on disk. */
export function devinDbSessionCandidatePath(cliDir: string, sessionId: string): string {
  return `${devinSessionsDbPathInStore(cliDir)}${SEPARATOR}${sessionId}`
}

export function splitDevinDbSessionCandidate(
  candidatePath: string
): { dbPath: string; sessionId: string } | null {
  const index = candidatePath.lastIndexOf(SEPARATOR)
  if (index <= 0 || index === candidatePath.length - 1) {
    return null
  }
  const dbPath = candidatePath.slice(0, index)
  return basename(dbPath) === SESSIONS_DB
    ? { dbPath, sessionId: candidatePath.slice(index + 1) }
    : null
}

type ChainNode = { nodeId: number; parentId: number | null; summarizedFrom: number | null }

/** The visible conversation: the main chain, preceded by any chain a compaction summary replaced. */
function devinVisibleChain(
  nodes: ReadonlyMap<number, ChainNode>,
  headId: number,
  depth = 0
): number[] {
  const path: ChainNode[] = []
  const seen = new Set<number>()
  for (let node = nodes.get(headId); node && !seen.has(node.nodeId);) {
    seen.add(node.nodeId)
    path.push(node)
    node = node.parentId === null ? undefined : nodes.get(node.parentId)
  }
  path.reverse()
  const summary = path.findIndex((node) => node.summarizedFrom !== null)
  const ids = path.map((node) => node.nodeId)
  const replaced = path[summary]?.summarizedFrom
  if (summary === -1 || replaced == null || depth >= MAX_SUMMARY_DEPTH) {
    return ids
  }
  return [...devinVisibleChain(nodes, replaced, depth + 1), ...ids.slice(summary + 1)]
}

type DevinToolCall = { name: string; input: unknown }

export type DevinConversationMessage = {
  role: 'user' | 'assistant'
  content: string
  metadata: Record<string, unknown> | null
  createdAtMs: number | null
  toolCalls: DevinToolCall[]
}

export type DevinConversation = {
  workingDirectory: string | null
  title: string | null
  model: string | null
  messages: DevinConversationMessage[]
}

export function readDevinConversation(dbPath: string, sessionId: string): DevinConversation | null {
  return readOpenCodeDatabase({
    dbPath,
    read: (db) => {
      const session = asRecord(
        db
          .prepare(
            'SELECT working_directory, title, model, main_chain_id FROM sessions WHERE id = ?'
          )
          .get(sessionId)
      )
      if (!session) {
        return null
      }
      const nodes = new Map<number, ChainNode>()
      let head: number | null = null
      const structure = db.prepare(
        `SELECT node_id, parent_node_id, json_extract(metadata, '$.summarized_from') AS summarized_from
         FROM message_nodes WHERE session_id = ?`
      )
      for (const value of structure.all(sessionId)) {
        const row = asRecord(value)
        if (row && typeof row.node_id === 'number') {
          nodes.set(row.node_id, {
            nodeId: row.node_id,
            parentId: typeof row.parent_node_id === 'number' ? row.parent_node_id : null,
            summarizedFrom: typeof row.summarized_from === 'number' ? row.summarized_from : null
          })
          head = head === null ? row.node_id : Math.max(head, row.node_id)
        }
      }
      // Older schemas declare main_chain_id as TEXT.
      const declared = Number(session.main_chain_id)
      const mainHead =
        session.main_chain_id !== null && Number.isInteger(declared) ? declared : head
      const chain = mainHead === null ? [] : devinVisibleChain(nodes, mainHead)
      const bodies = db.prepare(
        `SELECT node_id, created_at,
                json_extract(chat_message, '$.role') AS role,
                json_extract(chat_message, '$.content') AS content,
                json_extract(chat_message, '$.metadata') AS metadata,
                json_extract(chat_message, '$.tool_calls') AS tool_calls
         FROM message_nodes
         WHERE session_id = ? AND json_extract(chat_message, '$.role') IN ('user', 'assistant')`
      )
      const byNode = new Map<number, Record<string, unknown>>()
      for (const value of bodies.all(sessionId)) {
        const row = asRecord(value)
        if (row && typeof row.node_id === 'number') {
          byNode.set(row.node_id, row)
        }
      }
      return {
        workingDirectory: extractString(session.working_directory),
        title: extractString(session.title),
        model: extractString(session.model),
        messages: chain.flatMap((nodeId) => {
          const message = conversationMessage(byNode.get(nodeId))
          return message ? [message] : []
        })
      }
    }
  })
}

function conversationMessage(
  row: Record<string, unknown> | undefined
): DevinConversationMessage | null {
  const role = row?.role
  if (!row || (role !== 'user' && role !== 'assistant')) {
    return null
  }
  const metadata = asRecord(parseJson(row.metadata))
  // Injected prompts, e.g. a compaction's summarizer request, are user-role but not the person's.
  if (role === 'user' && metadata?.is_user_input !== true) {
    return null
  }
  const seconds = typeof row.created_at === 'number' ? row.created_at : 0
  return {
    role,
    content: typeof row.content === 'string' ? row.content : '',
    metadata,
    createdAtMs: seconds > 0 ? seconds * 1000 : null,
    toolCalls: toolCalls(parseJson(row.tool_calls))
  }
}

function toolCalls(value: unknown): DevinToolCall[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.flatMap((item) => {
    const call = asRecord(item)
    const name = call ? extractString(call.name) : null
    return call && name ? [{ name, input: call.arguments ?? null }] : []
  })
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed
  } catch {
    return null
  }
}
