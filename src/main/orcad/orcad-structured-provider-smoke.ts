import { openClaudeStreamJsonConnection } from '../claude/claude-stream-json-connection'

export async function smokeLoadOrcadStructuredProviders(): Promise<void> {
  const loaded = new Error('structured provider module loaded')
  try {
    await openClaudeStreamJsonConnection(
      { pathToClaudeCodeExecutable: 'unused', cwd: process.cwd(), options: {} },
      {},
      undefined,
      () => {
        throw loaded
      }
    )
  } catch (error) {
    if (error === loaded) {
      return
    }
    throw error
  }
  throw new Error('structured provider load check did not reach the SDK boundary')
}
