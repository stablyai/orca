import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openProfileStateDatabase } from '../database/profile-state-database'
import { readProfileStateRevision } from '../database/profile-state-revision'
import { profileStateDatabaseFile } from '../../../../shared/orca-profiles/profile-state-storage-paths'
import { writeProfileStateDomains } from './profile-state-domain-writes'
import { profileStateWriterPatching as patching } from './profile-state-patched-domains'

// Perf contract (#44784): each session patch (one per PTY bind) re-serialized the whole session domain and
// read every stored part, so a spawn burst over ~1,900 workspaces paid ~10M chars per bind. A one-entry patch
// must serialize, write and read the same amount at N and 10N workspaces. The whole-document hash still
// streams every part: older builds verify it.

const temporaryDirectories: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function session(workspaces: number): string {
  const tabsByWorktree: Record<string, unknown> = {}
  const layoutsByTabId: Record<string, unknown> = {}
  for (let index = 0; index < workspaces; index++) {
    tabsByWorktree[`repo::/w/${index}`] = [{ id: `tab-${index}`, title: 'Terminal' }]
    layoutsByTabId[`tab-${index}`] = { root: { type: 'leaf', leafId: `leaf-${index}` } }
  }
  return JSON.stringify({
    tabsByWorktree,
    terminalLayoutsByTabId: layoutsByTabId,
    activeTabId: null
  })
}

function measureBindPatch(workspaces: number, payload: string) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-session-patch-perf-'))
  temporaryDirectories.push(directory)
  const { db } = openProfileStateDatabase(profileStateDatabaseFile(directory), 'profile-a')
  try {
    writeProfileStateDomains(db, {
      expectedRevision: 0,
      replacements: [{ domain: 'workspaceSession', payload: session(workspaces) }],
      patching
    })
    db.exec(`CREATE TEMP TABLE part_writes (n INTEGER); INSERT INTO part_writes VALUES (0);
      CREATE TEMP TRIGGER count_part_insert AFTER INSERT ON main.profile_state_document_parts
        BEGIN UPDATE part_writes SET n = n + 1; END;
      CREATE TEMP TRIGGER count_part_update AFTER UPDATE ON main.profile_state_document_parts
        BEGIN UPDATE part_writes SET n = n + 1; END;
      CREATE TEMP TRIGGER count_part_delete AFTER DELETE ON main.profile_state_document_parts
        BEGIN UPDATE part_writes SET n = n + 1; END;`)
    let partReads = 0
    const prepare = db.prepare.bind(db)
    vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      if (/^\s*SELECT\b[\s\S]*\bFROM\s+profile_state_document_parts\s/.test(sql)) {
        partReads++
      }
      return prepare(sql)
    })
    let serializedChars = 0
    const stringify = JSON.stringify
    vi.spyOn(JSON, 'stringify').mockImplementation((...args: Parameters<typeof stringify>) => {
      const text = stringify(...args)
      // Strings are key escapes; values are what a whole-domain rebuild would re-serialize.
      if (typeof args[0] !== 'string') {
        serializedChars += text?.length ?? 0
      }
      return text
    })
    const result = writeProfileStateDomains(db, {
      expectedRevision: readProfileStateRevision(db),
      replacements: [],
      patching,
      patches: [
        {
          domain: 'workspaceSession',
          operations: [{ kind: 'set', path: ['terminalLayoutsByTabId', 'tab-1'], payload }]
        }
      ]
    })
    vi.restoreAllMocks()
    const [partWrites] = Object.values(db.prepare('SELECT n FROM part_writes').get() ?? {})
    return { changed: result.changed, partWrites, partReads, serializedChars }
  } finally {
    db.close()
  }
}

describe('session patch writes', () => {
  const bound = '{"root":{"type":"leaf","leafId":"leaf-1","ptyId":"pty-1"}}'

  it('writes one part and serializes only the patched entry, at N and 10N workspaces', () => {
    for (const workspaces of [2_000, 20_000]) {
      expect(measureBindPatch(workspaces, bound)).toEqual({
        changed: true,
        partWrites: 1,
        partReads: 0,
        serializedChars: bound.length
      })
    }
  })

  it('writes and serializes nothing beyond the entry when the patch changes nothing', () => {
    const unchanged = '{"root":{"type":"leaf","leafId":"leaf-1"}}'
    for (const workspaces of [2_000, 20_000]) {
      expect(measureBindPatch(workspaces, unchanged)).toEqual({
        changed: false,
        partWrites: 0,
        partReads: 0,
        serializedChars: unchanged.length
      })
    }
  })
})
