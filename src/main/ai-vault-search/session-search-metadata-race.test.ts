import { it, expect, vi } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionSearchStore } from './session-search-store'
import { parseSearchCandidates } from './session-search-parse-candidates'
import { registerSessionSearchIndexSink } from '../ai-vault/session-search-capture'
import {
  resetSessionParseCacheForTests,
  parseAgentSessionFileCached
} from '../ai-vault/session-scanner-parse-cache'
import {
  sessionCandidate,
  codexRolloutLines,
  CODEX_SESSION_ID,
  CODEX_ROLLOUT_FILE
} from './session-search-transcript-fixtures'
import { resetCodexSessionIndexTitleCacheForTests } from '../ai-vault/session-scanner-codex-title-index'
import * as sourceRead from '../native-chat/wsl-transcript-fs-access'
import * as metadataReader from '../ai-vault/session-scanner-codex-cached-metadata'

it.each(['same', 'different'])(
  'checks delayed cold metadata refresh against a newer %s Codex session',
  async (identity) => {
    const root = await mkdtemp(join(tmpdir(), 'search-metadata-race-'))
    const store = new SessionSearchStore(join(root, 'index.sqlite'))
    let release = () => {}
    let refreshing: Promise<void> | undefined
    let parsing: Promise<unknown> | undefined
    try {
      resetSessionParseCacheForTests()
      resetCodexSessionIndexTitleCacheForTests()
      registerSessionSearchIndexSink(store)
      const path = join(root, CODEX_ROLLOUT_FILE)
      const initial = `${codexRolloutLines(['echo'], 'output', 'raceneedle').join('\n')}\n`
      await writeFile(path, initial)
      const candidate = await sessionCandidate('codex', path, root)
      await parseSearchCandidates(store, [candidate])
      resetSessionParseCacheForTests()
      await writeFile(
        join(root, 'session_index.jsonl'),
        `${JSON.stringify({ id: CODEX_SESSION_ID, thread_name: 'renamed race title' })}\n`
      )
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      let entered = () => {}
      const reached = new Promise<void>((resolve) => {
        entered = resolve
      })
      const original = metadataReader.refreshCachedCodexMetadata
      vi.spyOn(metadataReader, 'refreshCachedCodexMetadata').mockImplementationOnce(
        async (candidate, metadata) => {
          const updated = await original(candidate, metadata)
          entered()
          await held
          return updated
        }
      )
      refreshing = parseSearchCandidates(store, [candidate])
      await reached
      await writeFile(
        path,
        initial
          .replace('/repo/app', '/repo/new-workspace')
          .replace('"branch":"main"', '"branch":"new-branch"')
          .replace(
            CODEX_SESSION_ID,
            identity === 'same' ? CODEX_SESSION_ID : '019f0000-2222-7222-8333-444444444444'
          )
      )
      const current = await sessionCandidate('codex', path, root)
      const readStream = vi.spyOn(sourceRead, 'openTranscriptReadStream')
      parsing = parseAgentSessionFileCached(current, process.platform)
      await Promise.resolve()
      expect(readStream).not.toHaveBeenCalled()
      expect(store.indexedMetadata(path)!.cwd).toBe('/repo/app')
      release()
      await Promise.all([refreshing, parsing])
      const afterRelease = store.indexedMetadata(path)!
      expect(afterRelease.cwd).toBe('/repo/new-workspace')
      expect(afterRelease.branch).toBe('new-branch')
    } finally {
      release()
      await Promise.allSettled([refreshing, parsing])
      vi.restoreAllMocks()
      registerSessionSearchIndexSink(null)
      store.close()
      resetSessionParseCacheForTests()
      resetCodexSessionIndexTitleCacheForTests()
      await rm(root, { recursive: true, force: true })
    }
  }
)
