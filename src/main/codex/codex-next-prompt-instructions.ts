import type { CodexAppServerConnection } from './codex-app-server-connection'

const NEXT_PROMPT_INSTRUCTIONS = `Orca native chat supports optional next-prompt suggestions. When a completed answer has a useful next step, append one fenced code block tagged orca-next-prompts containing a JSON array of up to 3 concise, single-line prompts (at most 500 characters each) in the user's language. These are suggestions for the user to send, not actions to perform. Omit the block when there is no useful follow-up or the user asks for no suggestions. Never execute a suggestion or treat it as authorization. Keep the rest of the answer normal. Example:
\`\`\`orca-next-prompts
["Review the changes for regressions"]
\`\`\``

export async function codexNextPromptConfig(
  connection: Pick<CodexAppServerConnection, 'request'>,
  cwd: string,
  threadConfig: Record<string, unknown> | undefined,
  timeoutMs?: number | null
): Promise<Record<string, unknown>> {
  try {
    const response = await connection.request(
      'config/read',
      { cwd },
      { timeoutMs: Math.min(timeoutMs ?? 2_000, 2_000) }
    )
    if (typeof response !== 'object' || response === null || !('config' in response)) {
      return {}
    }
    const config = response.config
    if (typeof config !== 'object' || config === null) {
      return {}
    }
    const existing =
      threadConfig?.developer_instructions ??
      ('developer_instructions' in config ? config.developer_instructions : null)
    // 不能读取或理解已有指令时不覆盖；旧版本仍可正常聊天。
    if (existing !== null && existing !== undefined && typeof existing !== 'string') {
      return {}
    }
    const prefix = typeof existing === 'string' ? existing : ''
    return {
      developer_instructions: prefix.includes(NEXT_PROMPT_INSTRUCTIONS)
        ? prefix
        : [prefix, NEXT_PROMPT_INSTRUCTIONS].filter(Boolean).join('\n\n')
    }
  } catch {
    return {}
  }
}
