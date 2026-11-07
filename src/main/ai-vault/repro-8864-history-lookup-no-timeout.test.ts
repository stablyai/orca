/**
 * Issue #8864 — Agent history lookup hangs forever.
 *
 * Opening Agent History triggers `aiVault.listSessions` → OpenCode SQLite
 * discovery/parse with no wall-clock timeout. SyncDatabase supports `timeout`
 * (busy wait ms), but OpenCode readers omit it. A pathological/contended
 * opencode.db (user report: 29 GB, missing indexes) keeps the main process
 * busy and the panel spinner forever because the renderer awaits the IPC with
 * no Promise.race either.
 *
 * Re-run:
 *   pnpm exec vitest run --config config/vitest.config.ts \
 *     src/main/ai-vault/repro-8864-history-lookup-no-timeout.test.ts
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()

describe('issue #8864 agent history lookup has no hang timeout', () => {
  it('SyncDatabase accepts a timeout option but OpenCode readers never pass one', () => {
    const syncDb = readFileSync(join(root, 'src/main/sqlite/sync-database.ts'), 'utf8')
    expect(syncDb).toMatch(/timeout\?: number/)
    expect(syncDb).toMatch(/timeout: options\.timeout/)

    const discovery = readFileSync(
      join(root, 'src/main/ai-vault/session-scanner-opencode-sqlite-discovery.ts'),
      'utf8'
    )
    const parser = readFileSync(
      join(root, 'src/main/ai-vault/session-scanner-opencode-sqlite.ts'),
      'utf8'
    )
    // Both open paths: readonly + fileMustExist only — no timeout.
    expect(discovery).toMatch(
      /new SyncDatabase\(dbPath, \{\s*readonly: true,\s*fileMustExist: true\s*\}\)/
    )
    expect(parser).toMatch(
      /new SyncDatabase\(dbPath, \{\s*readonly: true,\s*fileMustExist: true\s*\}\)/
    )
    expect(discovery).not.toMatch(/timeout\s*:/)
    expect(parser).not.toMatch(/timeout\s*:/)
  })

  it('session list query uses correlated COUNT with json_extract (unbounded work per session)', () => {
    const discovery = readFileSync(
      join(root, 'src/main/ai-vault/session-scanner-opencode-sqlite-discovery.ts'),
      'utf8'
    )
    // Per-session subquery over message + json_extract — catastrophic without indexes
    // on large OpenCode event/message tables (user-reported hang trigger).
    expect(discovery).toMatch(/\(SELECT COUNT\(\*\) FROM message m/)
    expect(discovery).toMatch(/json_extract\(m\.data, '\$\.role'\)/)
    expect(discovery).toMatch(/FROM session s/)
    expect(discovery).toMatch(/ORDER BY s\.time_updated DESC/)
  })

  it('local listSessions cache path has no Promise.race / wall-clock deadline', () => {
    const cached = readFileSync(join(root, 'src/main/ai-vault/cached-session-list.ts'), 'utf8')
    expect(cached).toMatch(/scanAiVaultSessions\(/)
    expect(cached).not.toMatch(/Promise\.race/)
    expect(cached).not.toMatch(/timeoutMs|AbortSignal|setTimeout/)

    const ipc = readFileSync(join(root, 'src/main/ipc/ai-vault.ts'), 'utf8')
    // Multi-host path times out runtime hosts only; local/SSH scans are unbounded.
    expect(ipc).toMatch(/AI_VAULT_ALL_HOST_RUNTIME_TIMEOUT_MS/)
    expect(ipc).toMatch(/scanLocalAiVaultSessions\(args\)/)
    // Local scope short-circuits before any timeout wrapper.
    expect(ipc).toMatch(
      /if \(executionHostScope === LOCAL_EXECUTION_HOST_ID\) \{\s*return scanLocalAiVaultSessions\(args\)/
    )
  })

  it('renderer Agent History refresh awaits listSessions with no client-side timeout', () => {
    const refresh = readFileSync(
      join(root, 'src/renderer/src/components/right-sidebar/ai-vault-session-refresh.ts'),
      'utf8'
    )
    expect(refresh).toMatch(/await window\.api\.aiVault\.listSessions\(/)
    expect(refresh).not.toMatch(/Promise\.race|AbortSignal|timeoutMs/)
    // loading stays true until the await settles — hang ⇒ spinner forever.
    expect(refresh).toMatch(/setLoading\(true\)/)
    expect(refresh).toMatch(/setLoading\(false\)/)
  })
})
