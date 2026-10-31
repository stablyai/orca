import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk'
import type { AgentJournalApprovalSubject } from '../../shared/agent-session-journal-types'
import {
  stripAnsiEscapeSequences,
  TERMINAL_CONTROL_CHARACTER_PATTERN
} from '../../shared/ansi-escape-sequences'
import type { ClaudePromptPresentation } from './claude-prompt-registry'

type ClaudePermissionOptions = Parameters<CanUseTool>[2]

function presentationText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const sanitized = stripAnsiEscapeSequences(value)
    .replace(TERMINAL_CONTROL_CHARACTER_PATTERN, '')
    .trim()
  return sanitized.length > 0 ? sanitized : null
}

export function claudePermissionPresentation(
  options: ClaudePermissionOptions
): ClaudePromptPresentation {
  const title = presentationText(options.title)
  const displayName = presentationText(options.displayName)
  const description = presentationText(options.description)
  const decisionReason = presentationText(options.decisionReason)
  const blockedPath = presentationText(options.blockedPath)
  const matchedSource = presentationText(options.matchedAskRule?.source)
  const matchedToolName = presentationText(options.matchedAskRule?.toolName)
  const matchedRuleContent = presentationText(options.matchedAskRule?.ruleContent)
  return {
    ...(title ? { title } : {}),
    ...(displayName ? { displayName } : {}),
    ...(description ? { description } : {}),
    ...(decisionReason ? { decisionReason } : {}),
    ...(blockedPath ? { blockedPath } : {}),
    ...(matchedSource && matchedToolName
      ? {
          matchedAskRule: {
            source: matchedSource,
            toolName: matchedToolName,
            ...(matchedRuleContent ? { ruleContent: matchedRuleContent } : {})
          }
        }
      : {})
  }
}

export function claudePermissionSubject(
  toolName: string,
  input: Record<string, unknown>
): AgentJournalApprovalSubject | undefined {
  if (toolName !== 'ExitPlanMode') {
    return undefined
  }
  const text = presentationText(input.plan)
  if (!text) {
    return undefined
  }
  const filePath = presentationText(input.planFilePath) ?? presentationText(input.plan_file_path)
  return {
    kind: 'plan',
    text,
    ...(filePath ? { filePath } : {})
  }
}
