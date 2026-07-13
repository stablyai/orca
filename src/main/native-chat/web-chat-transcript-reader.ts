import { existsSync } from 'node:fs'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import type { ReadTranscriptResult } from './transcript-reader'
import SyncDatabase from '../sqlite/sync-database'
import { tableExists } from '../opencode-usage/schema-helpers'
import { chatImportDbPath } from '../chat-import/chat-import-paths'
import { errorMessage } from '../ai-vault/session-scanner-values'
import { WEB_CHAT_AGENTS, type WebChatAgent } from '../../shared/ai-vault-types'

// Why: agent 파라미터는 AgentType(열린 문자열 유니온)이라, 웹 3종만 이 리더로
// 라우팅하기 위한 문자열 기반 가드. isWebChatAgent(AiVaultAgent)와 달리 임의 문자열을 받는다.
export function isWebChatAgentString(agent: string): agent is WebChatAgent {
  return (WEB_CHAT_AGENTS as readonly string[]).includes(agent)
}

const AGENT_TO_SOURCE: Record<WebChatAgent, string> = {
  chatgpt: 'CHATGPT',
  'claude-web': 'CLAUDE',
  'gemini-web': 'GEMINI'
}

type MsgRow = { role: string; idx: number; text: string | null; created_at: string | null }

/**
 * 웹 대화 한 건(convId=`<source>/<sessionId>`)의 전체 메시지를 chats.db에서 읽어
 * NativeChatMessage[]로 변환한다. 파일 기반 트랜스크립트와 달리 캡·라이브 tail 없음.
 * DB/테이블/대화 부재는 조용히 빈 결과로 처리(다른 렌더 방해 금지).
 */
export function readWebChatConversation(
  agent: WebChatAgent,
  sessionId: string,
  dbPathOverride?: string
): ReadTranscriptResult {
  const dbPath = dbPathOverride ?? chatImportDbPath()
  if (!existsSync(dbPath)) {
    return { messages: [] }
  }
  const convId = `${AGENT_TO_SOURCE[agent]}/${sessionId}`
  let db: SyncDatabase | null = null
  try {
    // Why: query_only(OS-readonly 아님)로 WAL 모드 DB를 안전하게 읽는다(자매 파서와 동일).
    db = new SyncDatabase(dbPath, { fileMustExist: true })
    db.pragma('query_only = ON')
    if (!tableExists(db, 'messages')) {
      return { messages: [] }
    }
    const rows = db
      .prepare(
        'SELECT role, idx, text, created_at FROM messages WHERE conv_id = ? ORDER BY idx ASC'
      )
      .all(convId) as MsgRow[]
    const messages: NativeChatMessage[] = []
    for (const row of rows) {
      const text = row.text
      if (!text) {
        continue
      }
      messages.push({
        id: `${convId}#${row.idx}`,
        role: row.role === 'USER' ? 'user' : 'assistant',
        blocks: [{ type: 'text', text }],
        timestamp: row.created_at ? Date.parse(row.created_at) || null : null,
        source: 'transcript'
      })
    }
    return { messages }
  } catch (err) {
    return { error: errorMessage(err) }
  } finally {
    db?.close()
  }
}
