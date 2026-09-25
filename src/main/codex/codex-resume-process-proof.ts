import { tokenizeCustomCommandTemplate } from '../../shared/commit-message-prompt'
import type { AgentSessionProcessIdentity } from '../../shared/agent-session-record'
import { readStructuredTuiProcessIdentity } from '../runtime/structured-tui-process-identity'

const PROCESS_COMMAND_LINE_MAX_CHARS = 16 * 1024

function tokenizeWindowsProcessCommandLine(commandLine: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quoted = false
  let started = false
  let index = 0
  while (index < commandLine.length) {
    const char = commandLine[index]!
    if (!started && /\s/.test(char)) {
      index += 1
      continue
    }
    started = true
    if (char === '\\') {
      let backslashes = 0
      while (commandLine[index] === '\\') {
        backslashes += 1
        index += 1
      }
      if (commandLine[index] === '"') {
        current += '\\'.repeat(Math.floor(backslashes / 2))
        if (backslashes % 2 === 1) {
          current += '"'
          index += 1
        }
      } else {
        current += '\\'.repeat(backslashes)
      }
      continue
    }
    if (char === '"') {
      if (quoted && commandLine[index + 1] === '"') {
        current += '"'
        index += 2
        continue
      }
      quoted = !quoted
      index += 1
      continue
    }
    if (!quoted && /\s/.test(char)) {
      tokens.push(current)
      current = ''
      started = false
      index += 1
      continue
    }
    current += char
    index += 1
  }
  if (started) {
    tokens.push(current)
  }
  return tokens
}

function tokenizeProcessCommandLine(
  commandLine: string,
  platform: NodeJS.Platform
): string[] | null {
  if (!commandLine || commandLine.length > PROCESS_COMMAND_LINE_MAX_CHARS) {
    return null
  }
  if (platform === 'win32') {
    return tokenizeWindowsProcessCommandLine(commandLine)
  }
  const parsed = tokenizeCustomCommandTemplate(commandLine)
  return parsed.ok ? parsed.tokens : null
}

export function isCodexResumeProcessCommandLine(
  commandLine: string,
  threadId: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const tokens = tokenizeProcessCommandLine(commandLine, platform)
  if (!tokens || !threadId) {
    return false
  }
  return tokens.some((token, index) => token === 'resume' && tokens[index + 1] === threadId)
}

type StructuredTuiIdentityInput = Parameters<typeof readStructuredTuiProcessIdentity>[0]

export function readCodexResumeProcessIdentity(
  input: Omit<StructuredTuiIdentityInput, 'agent' | 'processCommandMatches'> & { threadId: string }
): Promise<AgentSessionProcessIdentity> {
  const { threadId, ...identityInput } = input
  const platform = input.platform ?? process.platform
  return readStructuredTuiProcessIdentity({
    ...identityInput,
    agent: 'codex',
    processCommandMatches: (command) => isCodexResumeProcessCommandLine(command, threadId, platform)
  })
}
