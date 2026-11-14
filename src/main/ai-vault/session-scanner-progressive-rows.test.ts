import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { scanAiVaultSessions } from './session-scanner'
import * as parseCache from './parse-cache/session-scanner-parse-cache'
import { isolatedScanRoots, jsonLines } from './scanner-fixtures/session-scanner-test-fixtures'
import type { AiVaultRowObserver } from '../../shared/ai-vault-scan-rows'
import type { AiVaultSession } from '../../shared/ai-vault/contracts/ai-vault-types'

it('delivers a completed row before its held sibling and preserves final aliases and scoped rows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-progressive-rows-'))
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const roots = isolatedScanRoots(root)
  const extra = join(root, 'extra-codex')
  let releaseSend!: () => void
  const heldSend = new Promise<void>((resolve) => {
    releaseSend = resolve
  })
  const rows = new Map<string, AiVaultSession>()
  const onRows: AiVaultRowObserver = async (delta) => {
    for (const id of delta.removed) {
      rows.delete(id)
    }
    for (const row of delta.upserts) {
      rows.set(row.id, row)
    }
    await heldSend
  }
  let scan: ReturnType<typeof scanAiVaultSessions> | undefined
  try {
    for (const dir of [roots.codexSessionsDir, extra]) {
      await mkdir(dir, { recursive: true })
      for (const [id, day] of [
        ['held', 3],
        ['ready', 2]
      ] as const) {
        const path = join(dir, `rollout-${id}.jsonl`)
        const time = new Date(`2026-10-0${day}T00:00:00.000Z`)
        await writeFile(
          path,
          jsonLines([
            { type: 'session_meta', payload: { id, cwd: '/elsewhere' } },
            {
              type: 'event_msg',
              timestamp: time.toISOString(),
              payload: { type: 'user_message', message: id }
            }
          ])
        )
        await utimes(path, time, time)
      }
    }
    const bucket = join(roots.piSessionsDir, '--repo-old--')
    await mkdir(bucket, { recursive: true })
    const old = join(bucket, 'old.jsonl')
    await writeFile(
      old,
      jsonLines([
        {
          type: 'session',
          version: 3,
          id: 'old',
          timestamp: '2026-01-01T00:00:00.000Z',
          cwd: '/repo/old'
        },
        {
          type: 'message',
          message: { role: 'user', content: [{ type: 'text', text: 'older scoped session' }] }
        }
      ])
    )
    await utimes(old, new Date('2026-01-01'), new Date('2026-01-01'))
    const original = parseCache.parseListedSessionFile
    const spy = vi
      .spyOn(parseCache, 'parseListedSessionFile')
      .mockImplementation(async (...args) => {
        if (args[0].file.path.endsWith('rollout-held.jsonl')) {
          await held
        }
        return original(...args)
      })
    const options = {
      ...roots,
      additionalCodexSessionsDirs: [extra],
      limit: 2,
      scopePaths: ['/repo/old']
    }
    scan = scanAiVaultSessions(options, onRows)
    await vi.waitFor(() =>
      expect([...rows.values()].map((row) => row.sessionId)).toContain('ready')
    )
    expect([...rows.values()].map((row) => row.sessionId)).not.toContain('held')
    release()
    const streamed = await scan
    spy.mockRestore()
    const ordinary = await scanAiVaultSessions(options)
    expect(streamed.sessions).toEqual(ordinary.sessions)
    expect(streamed.sessions.map((row) => row.sessionId)).toEqual(['held', 'ready', 'old'])
    expect(streamed.sessions.filter((row) => row.sessionId === 'ready')).toHaveLength(1)
  } finally {
    release()
    releaseSend()
    await scan?.catch(() => undefined)
    vi.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  }
})
