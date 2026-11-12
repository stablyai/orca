import { openCode2ForkStore } from './transcript-opencode2-fork.test-fixture'
import { handleOpenCodeSqliteRequest } from './session-scanner-opencode-sqlite-dispatch'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type Database from '../../../../sqlite/sync-database'

const fixtures: { db: Database.Database; root: string }[] = []
afterEach(() => {
  for (const { db, root } of fixtures.splice(0)) {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

it('captures the M1 copied roots without events, excludes a racing CLI root, and honors before', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-native-opencode2-fork-'))
  const path = join(root, 'opencode.db')
  const db = openCode2ForkStore(path)
  fixtures.push({ db, root })
  const request = {
    id: 1,
    kind: 'fork-coverage' as const,
    dbPath: path,
    sessionId: 'ses_e4d797526ffee7BYM6ri3gpmbg',
    sourceSessionId: 'ses_e4d7a0c31ffejclsdjiiDszHMB'
  }
  expect(await handleOpenCodeSqliteRequest(request)).toEqual({
    id: 1,
    ok: true,
    value: ['msg_1b2868ada001HhsJYcY0OtPOjp_4']
  })
  expect(
    await handleOpenCodeSqliteRequest({ ...request, sourceSessionId: 'wrong-source' })
  ).toMatchObject({ ok: false })
  db.exec(`UPDATE session_v2 SET fork_boundary =
    '{"type":"before","messageID":"msg_1b285f9e10016X0Hu1rKOHAACe"}'
    WHERE id = 'ses_e4d797526ffee7BYM6ri3gpmbg';
    DELETE FROM session_message WHERE session_id = 'ses_e4d797526ffee7BYM6ri3gpmbg' AND seq < 90;`)
  expect(await handleOpenCodeSqliteRequest(request)).toEqual({ id: 1, ok: true, value: [] })
})
