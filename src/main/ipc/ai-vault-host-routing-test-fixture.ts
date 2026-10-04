import type { AiVaultSession } from '../../shared/ai-vault-types'

export function hostRoutingSession(
  executionHostId: AiVaultSession['executionHostId'],
  sessionId: string
): AiVaultSession {
  return {
    id: `${executionHostId}:codex:${sessionId}:/tmp/${sessionId}.jsonl`,
    executionHostId,
    agent: 'codex',
    sessionId,
    title: sessionId,
    cwd: '/repo',
    branch: null,
    model: null,
    filePath: `/tmp/${sessionId}.jsonl`,
    codexHome: null,
    createdAt: null,
    updatedAt:
      sessionId === 'runtime-session'
        ? '2026-07-04T03:00:00.000Z'
        : sessionId === 'remote-session'
          ? '2026-07-04T02:00:00.000Z'
          : '2026-07-04T01:00:00.000Z',
    modifiedAt: '2026-07-04T00:00:00.000Z',
    messageCount: 1,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: `codex resume ${sessionId}`,
    subagent: null
  }
}
