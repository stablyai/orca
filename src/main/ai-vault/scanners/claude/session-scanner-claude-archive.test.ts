import { appendFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { scanAiVaultSessions } from '../../session-scanner'
import {
  isolatedScanRoots,
  jsonLines,
  writeJsonlFile
} from '../../scanner-fixtures/session-scanner-test-fixtures'

it.each(['all sessions', 'project sessions'])(
  'updates Claude archive visibility on the next %s scan without changing the transcript',
  async (scope) => {
    const root = await mkdtemp(join(tmpdir(), 'orca-claude-archive-'))
    try {
      const roots = isolatedScanRoots(root)
      const cwd = join(root, 'project')
      const bucket = join(roots.claudeProjectsDir, cwd.replace(/[^a-zA-Z0-9]/g, '-'))
      const archivedId = 'd3129807-c843-41ad-8c05-bcf22267da66'
      const activeId = 'a64d2cab-6f5a-491d-ab1a-72fec74064ae'
      const transcript = join(bucket, `${archivedId}.jsonl`)
      const activeTranscript = join(bucket, `${activeId}.jsonl`)
      const markerDir = join(bucket, archivedId)
      const marker = join(markerDir, 'archived.json')
      const initialTime = '2026-01-01T00:00:00.000Z'
      const archivedAt = '2026-01-01T01:00:00.000Z'
      const userTurn = {
        type: 'user',
        sessionId: archivedId,
        cwd,
        timestamp: initialTime,
        message: { role: 'user', content: 'A real prompt' }
      }
      await writeJsonlFile(transcript, [userTurn])
      await writeJsonlFile(activeTranscript, [
        {
          ...userTurn,
          sessionId: activeId,
          message: { role: 'user', content: 'Active conversation' }
        }
      ])
      await utimes(activeTranscript, new Date(initialTime), new Date(initialTime))
      await utimes(transcript, new Date(archivedAt), new Date(archivedAt))
      await mkdir(markerDir)
      const original = await readFile(transcript, 'utf8')
      const list = async (limit = 2) => {
        const { sessions } = await scanAiVaultSessions({
          ...roots,
          claudeProfileProjectsDirs: [],
          wslHomeDirs: [],
          limit,
          limitPerAgent: limit,
          ...(scope === 'project sessions' ? { scopePaths: [cwd], scopeOnly: true } : {})
        })
        return sessions.map((session) => session.title).sort()
      }

      expect(await list()).toEqual(['A real prompt', 'Active conversation'])
      await writeFile(marker, JSON.stringify({ archived: true, at: archivedAt, by: 'sdk' }))
      expect(await list(1)).toEqual(['Active conversation'])
      await writeFile(marker, JSON.stringify({ archived: false, at: archivedAt, by: 'sdk' }))
      expect(await list()).toEqual(['A real prompt', 'Active conversation'])
      expect(await readFile(transcript, 'utf8')).toBe(original)

      // Claude treats a newer human prompt as unarchiving, even with a stale archive marker.
      await writeFile(marker, JSON.stringify({ archived: true, at: archivedAt, by: 'sdk' }))
      const timestamp = '2026-01-01T02:00:00.000Z'
      await appendFile(
        transcript,
        `${jsonLines([
          { ...userTurn, timestamp, message: { role: 'user', content: [{ type: 'tool_result' }] } }
        ])}\n`
      )
      expect(await list()).toEqual(['Active conversation'])
      await appendFile(transcript, `${jsonLines([{ ...userTurn, timestamp }])}\n`)
      expect(await list()).toEqual(['A real prompt', 'Active conversation'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)
