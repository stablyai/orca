import { describe, expect, it } from 'vitest'
import { AI_VAULT_AGENT_SOURCES } from './session-scanner-agent-sources'
import { isDiscoverableSessionFile } from './session-file-discovery'

const codex = AI_VAULT_AGENT_SOURCES.codex
if (!codex) {
  throw new Error('codex agent source missing')
}
const rootDir = '/home/u/.codex/sessions'

describe('Codex session file discovery', () => {
  it('admits rollout-named compressed archives and plain rollouts', () => {
    expect(
      isDiscoverableSessionFile(codex, rootDir, `${rootDir}/2026/08/20/rollout-2026-a.jsonl.zst`)
    ).toBe(true)
    expect(
      isDiscoverableSessionFile(codex, rootDir, `${rootDir}/2026/08/20/rollout-2026-a.jsonl`)
    ).toBe(true)
  })

  it('rejects compressed files that are not rollout archives', () => {
    expect(isDiscoverableSessionFile(codex, rootDir, `${rootDir}/2026/08/20/notes.zst`)).toBe(false)
    expect(isDiscoverableSessionFile(codex, rootDir, `${rootDir}/2026/08/20/backup.tar.zst`)).toBe(
      false
    )
  })
})
