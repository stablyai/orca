import { describe, expect, it } from 'vitest'
import { codexSessionAliasKey, dropCompressedCodexRolloutTwins } from './codex-session-root-dedup'
import type { AiVaultSession } from '../../../../shared/ai-vault/contracts/ai-vault-types'

type Candidate = { agent: 'codex' | 'claude'; path: string }

const accessors = {
  isCodex: (candidate: Candidate) => candidate.agent === 'codex',
  getFilePath: (candidate: Candidate) => candidate.path
}

function rolloutPath(name: string): string {
  return `/home/u/.codex/sessions/2026/08/20/${name}`
}

describe('dropCompressedCodexRolloutTwins', () => {
  it('drops a compressed rollout when its plain twin is listed', () => {
    const plain = { agent: 'codex' as const, path: rolloutPath('rollout-2026-a.jsonl') }
    const compressed = { agent: 'codex' as const, path: rolloutPath('rollout-2026-a.jsonl.zst') }
    expect(dropCompressedCodexRolloutTwins([compressed, plain], accessors)).toEqual([plain])
  })

  it('keeps a compressed rollout whose plain twin is absent', () => {
    const compressed = { agent: 'codex' as const, path: rolloutPath('rollout-2026-b.jsonl.zst') }
    const other = { agent: 'codex' as const, path: rolloutPath('rollout-2026-c.jsonl') }
    expect(dropCompressedCodexRolloutTwins([compressed, other], accessors)).toEqual([
      compressed,
      other
    ])
  })

  it('leaves non-rollout and non-codex compressed files alone', () => {
    const unrelated = { agent: 'codex' as const, path: rolloutPath('notes.jsonl.zst') }
    const claude = {
      agent: 'claude' as const,
      path: '/home/u/.claude/projects/p/session.jsonl.zst'
    }
    expect(dropCompressedCodexRolloutTwins([unrelated, claude], accessors)).toEqual([
      unrelated,
      claude
    ])
  })
})

describe('codexSessionAliasKey', () => {
  const session = {
    agent: 'codex',
    sessionId: 'sess-1',
    filePath: rolloutPath('rollout-2026-a.jsonl.zst'),
    executionHostId: null
  } as unknown as AiVaultSession

  it('aliases compressed rollouts like plain ones', () => {
    expect(codexSessionAliasKey(session)).toContain('rollout-2026-a.jsonl.zst')
  })
})
