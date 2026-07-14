import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { isTextBlock, type NativeChatMessage } from '../../shared/native-chat-types'

// Why: Claude Code는 cwd의 '/'·'.'를 '-'로 접어 projects/<slug> 디렉토리를 만든다.
// go/no-go로 이 인코딩이면 claude --resume이 파일을 찾는 걸 확인함.
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[/.]/g, '-')
}

let cachedVersion: string | null = null
function readClaudeVersion(): string {
  if (cachedVersion) {
    return cachedVersion
  }
  try {
    // "2.1.207 (Claude Code)" → "2.1.207". 하드코딩 금지(버전 스키마 취약성 완화).
    // SSH 유스케이스: 바이너리가 멎어도 메인 프로세스가 블록되지 않도록 타임아웃을 둔다.
    cachedVersion =
      execFileSync('claude', ['--version'], { encoding: 'utf-8', timeout: 5000 })
        .trim()
        .split(/\s+/)[0] || '0.0.0'
  } catch {
    cachedVersion = '0.0.0'
  }
  return cachedVersion
}

function messageText(m: NativeChatMessage): string {
  return m.blocks
    .filter(isTextBlock)
    .map((b) => b.text)
    .join('\n')
    .trim()
}

/**
 * 웹 대화를 Claude Code 세션 JSONL로 써서 claude --resume이 이어받게 한다(go/no-go 실증).
 * 파일: ~/.claude/projects/<slug>/<sessionId>.jsonl. 빈 대화·쓰기실패 → {error}.
 */
export function writeWebChatAsClaudeSession(args: {
  messages: NativeChatMessage[]
  cwd: string
  gitBranch: string | null
  dirOverride?: string
}): { sessionId: string } | { error: string } {
  const turns = args.messages.filter((m) => messageText(m))
  if (turns.length === 0) {
    return { error: 'empty conversation' }
  }
  const sessionId = randomUUID()
  const version = readClaudeVersion()
  const base = {
    sessionId,
    cwd: args.cwd,
    ...(args.gitBranch ? { gitBranch: args.gitBranch } : {}),
    version,
    userType: 'external' as const,
    isSidechain: false
  }
  // Why: record building (incl. new Date(...).toISOString()) can throw (e.g. RangeError on
  // an out-of-range timestamp) — keep it inside try so the caller always gets {error}, never
  // an unhandled throw, and its error→seed fallback still fires.
  try {
    const lines: string[] = []
    let parentUuid: string | null = null
    for (const m of turns) {
      const uuid = randomUUID()
      const text = messageText(m)
      // 각 메시지 고유 timestamp를 쓴다. 없으면(null) 기록 시각으로 대체 — 다회차 대화의 순서를 보존.
      const timestamp =
        m.timestamp != null ? new Date(m.timestamp).toISOString() : new Date().toISOString()
      const rec =
        m.role === 'user'
          ? {
              parentUuid,
              uuid,
              type: 'user',
              timestamp,
              entrypoint: 'cli',
              permissionMode: 'default',
              promptSource: 'user',
              message: { role: 'user', content: text },
              ...base
            }
          : {
              parentUuid,
              uuid,
              type: 'assistant',
              timestamp,
              message: {
                role: 'assistant',
                type: 'message',
                model: 'claude-opus-4-8',
                content: [{ type: 'text', text }],
                stop_reason: 'end_turn'
              },
              ...base
            }
      lines.push(JSON.stringify(rec))
      parentUuid = uuid
    }
    const dir =
      args.dirOverride ?? join(homedir(), '.claude', 'projects', claudeProjectSlug(args.cwd))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${sessionId}.jsonl`), `${lines.join('\n')}\n`)
    return { sessionId }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}
