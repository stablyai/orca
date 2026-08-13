export type StructuredHandoffProviderCase = {
  provider: 'claude' | 'codex'
  accountHome: { variable: 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME'; pathName: string }
}

export const STRUCTURED_HANDOFF_PROVIDER_CASES: StructuredHandoffProviderCase[] = [
  { provider: 'codex', accountHome: { variable: 'CODEX_HOME', pathName: 'codex-home' } },
  {
    provider: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', pathName: 'claude-home' }
  }
]

export function structuredHandoffTestProcess(now: number, spawnToken: string, pid: number) {
  return { hostId: 'local', pid, processStartTimeMs: now - 1_000, spawnToken }
}

export function structuredHandoffTestLink(input: {
  provider: 'claude' | 'codex'
  fence: number
  id: string
  now: number
  claudeSessionId: string
  codexThreadId: string
}) {
  return {
    linkId: input.id,
    handle:
      input.provider === 'claude'
        ? ({
            provider: 'claude' as const,
            sessionId: input.claudeSessionId,
            leafUuid: input.id.startsWith('native-link') ? 'tui-exit-leaf' : 'current-leaf'
          } as const)
        : ({ provider: 'codex' as const, threadId: input.codexThreadId } as const),
    origin: 'resumed' as const,
    mintedAtFence: input.fence,
    observedAt: input.now
  }
}
