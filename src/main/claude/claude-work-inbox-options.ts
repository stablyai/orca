import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { hasAppEnvironment } from '../../shared/app-environment'
import { WORK_INBOX_ROUTING_INSTRUCTIONS } from '../../shared/work-inbox-routing-instructions'
import {
  workInboxCliServer,
  WORK_INBOX_ALLOWED_TOOLS
} from '../runtime/work-inbox/work-inbox-cli-launch'
type InboxOptions = Pick<Options, 'systemPrompt' | 'mcpServers' | 'allowedTools'>

function systemPrompt(prompt: Options['systemPrompt']): Options['systemPrompt'] {
  if (typeof prompt === 'string') {
    return [prompt, WORK_INBOX_ROUTING_INSTRUCTIONS].join('\n')
  }
  if (Array.isArray(prompt)) {
    return [...prompt, WORK_INBOX_ROUTING_INSTRUCTIONS]
  }
  if (prompt?.type === 'custom') {
    return {
      ...prompt,
      prompt: [
        ...(Array.isArray(prompt.prompt) ? prompt.prompt : [prompt.prompt]),
        WORK_INBOX_ROUTING_INSTRUCTIONS
      ]
    }
  }
  return {
    type: 'preset',
    preset: 'claude_code',
    ...prompt,
    append: [prompt?.append, WORK_INBOX_ROUTING_INSTRUCTIONS].filter(Boolean).join('\n')
  }
}

export function claudeWorkInboxOptions(
  options: InboxOptions,
  env?: Record<string, string>
): InboxOptions {
  if (!hasAppEnvironment() || !env?.ORCA_AGENT_SESSION_ID || env.ORCA_WORK_INBOX_ROUTING !== '1') {
    return {}
  }
  return {
    mcpServers: { ...options.mcpServers, orca_work_inbox: workInboxCliServer(env) },
    allowedTools: [...(options.allowedTools ?? []), ...WORK_INBOX_ALLOWED_TOOLS],
    systemPrompt: systemPrompt(options.systemPrompt)
  }
}
