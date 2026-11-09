import type { IncomingHttpHeaders } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseAgentHookJson } from '../../shared/agent-hook-listener/request-body'
import type { AgentHookSource } from '../../shared/agent-hook-listener/transport/agent-hook-relay'
import { getAppEnvironment, hasAppEnvironment } from '../../shared/app-environment'
import { listClaudeProfileHomes } from '../claude-accounts/claude-profile-homes'

/** Sent when the hook script asks Orca to allow one shared Claude memory write. */
export const CLAUDE_MEMORY_PERMISSION_DECISION = 'claude-permission-memory-v1'

const DECISION_HEADER = 'x-orca-hook-decision'
const MEMORY_TOOLS = new Set(['Write', 'Edit', 'MultiEdit'])

/** Claude Code accepts this and skips its prompt. Any other reply is ignored by the hook script. */
export const CLAUDE_MEMORY_PERMISSION_ALLOW = JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PermissionRequest',
    decision: { behavior: 'allow' }
  }
})

export type ClaudeMemoryPermissionRoots = {
  homeDir: string
  /** Profile homes whose `projects` directory is linked at the real Claude home. */
  profileHomes?: readonly string[]
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null
}

/** Absolute path with `.` and `..` folded. A `..` above the root is refused, not kept. */
function lexicalAbsolute(filePath: string): string | null {
  if (filePath.includes('\0')) {
    return null
  }
  const slash = filePath.replaceAll('\\', '/')
  const drive = /^[A-Za-z]:\//.exec(slash)
  if (!slash.startsWith('/') && !drive) {
    return null
  }
  const prefix = drive ? slash.slice(0, 2) : ''
  const body = drive ? slash.slice(2) : slash
  const parts: string[] = []
  for (const part of body.split('/')) {
    if (part === '' || part === '.') {
      continue
    }
    if (part === '..') {
      if (parts.length === 0) {
        return null
      }
      parts.pop()
      continue
    }
    parts.push(part)
  }
  return `${prefix}/${parts.join('/')}`
}

function underProjectMemory(root: string, filePath: string): boolean {
  const rootPath = lexicalAbsolute(root)
  const file = lexicalAbsolute(filePath)
  if (!rootPath || !file) {
    return false
  }
  const prefix = `${rootPath}/`
  if (!file.startsWith(prefix)) {
    return false
  }
  const rest = file.slice(prefix.length).split('/')
  return (
    rest.length >= 4 &&
    rest[0] === 'projects' &&
    rest[1] !== '' &&
    rest[2] === 'memory' &&
    rest.slice(3).every((part) => part !== '')
  )
}

/** True only for `<profile home>/projects/<one>/memory/<file>` or `~/.claude/projects/<one>/memory/<file>`. */
export function isClaudeSharedMemoryFile(
  filePath: string,
  roots: ClaudeMemoryPermissionRoots
): boolean {
  if (underProjectMemory(join(roots.homeDir, '.claude'), filePath)) {
    return true
  }
  return (roots.profileHomes ?? []).some((home) => underProjectMemory(home, filePath))
}

export function defaultClaudeMemoryPermissionRoots(): ClaudeMemoryPermissionRoots {
  if (!hasAppEnvironment()) {
    return { homeDir: homedir(), profileHomes: [] }
  }
  try {
    return {
      homeDir: homedir(),
      profileHomes: listClaudeProfileHomes(getAppEnvironment().getPath('userData'))
    }
  } catch {
    return { homeDir: homedir(), profileHomes: [] }
  }
}

/**
 * Allows Write, Edit, and MultiEdit of auto-memory under a symlinked Claude profile.
 * Claude resolves `projects` to `~/.claude` and then treats that directory as protected,
 * so its own memory exemption never matches. Every other hook still gets no decision.
 */
export function claudeProfileMemoryPermissionAllow(
  source: AgentHookSource,
  body: unknown,
  headers: IncomingHttpHeaders,
  roots: ClaudeMemoryPermissionRoots = defaultClaudeMemoryPermissionRoots()
): string | null {
  if (source !== 'claude' || headers[DECISION_HEADER] !== CLAUDE_MEMORY_PERMISSION_DECISION) {
    return null
  }
  const raw = record(body)?.payload
  let hook: Record<string, unknown> | null = null
  try {
    hook = record(typeof raw === 'string' ? parseAgentHookJson(raw) : raw)
  } catch {
    return null
  }
  if (!hook || hook.hook_event_name !== 'PermissionRequest') {
    return null
  }
  if (typeof hook.tool_name !== 'string' || !MEMORY_TOOLS.has(hook.tool_name)) {
    return null
  }
  const input = record(hook.tool_input)
  const filePath = input?.file_path
  if (typeof filePath !== 'string' || !isClaudeSharedMemoryFile(filePath.trim(), roots)) {
    return null
  }
  return CLAUDE_MEMORY_PERMISSION_ALLOW
}
