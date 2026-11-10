import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { openProfileStateDatabase, profileStateDatabaseFile } from './profile-state-database'
import { exportProfileStateJson, importProfileStateJson } from './profile-state-documents'
import { writeProfileStateDomains } from './profile-state-domain-writes'

const directories: string[] = []
afterEach(() => {
  for (const path of directories.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})
function open() {
  const path = mkdtempSync(join(tmpdir(), 'orca-remote-parts-'))
  directories.push(path)
  return openProfileStateDatabase(profileStateDatabaseFile(path), 'parts-test').db
}

it('migrates a legacy snapshot, retains unrelated workspaces, and applies ordered removals and empty maps', () => {
  const db = open()
  try {
    importProfileStateJson(
      db,
      '{"remoteLayoutSnapshots":{"env":{"workspaces":{"a":{"tabs":[{"title":"old"}]},"b":{"tabs":[]}}}},"other":1}'
    )
    writeProfileStateDomains(db, {
      expectedRevision: 1,
      replacements: [],
      partsUpdate: {
        domain: 'remoteLayoutSnapshots',
        order: ['["env","workspaces","b"]', '["env","workspaces","a"]'],
        parts: [{ key: '["env","workspaces","a"]', payload: '{"tabs":[{"title":"new"}]}' }]
      }
    })
    expect(exportProfileStateJson(db)).toBe(
      '{"remoteLayoutSnapshots":{"env":{"workspaces":{"b":{"tabs":[]},"a":{"tabs":[{"title":"new"}]}}}},"other":1}'
    )
    writeProfileStateDomains(db, {
      expectedRevision: 2,
      replacements: [],
      partsUpdate: {
        domain: 'remoteLayoutSnapshots',
        order: ['["env","workspaces"]'],
        parts: [{ key: '["env","workspaces"]', payload: '{}' }]
      }
    })
    expect(exportProfileStateJson(db)).toBe(
      '{"remoteLayoutSnapshots":{"env":{"workspaces":{}}},"other":1}'
    )
    writeProfileStateDomains(db, {
      expectedRevision: 3,
      replacements: [],
      partsUpdate: {
        domain: 'remoteLayoutSnapshots',
        order: ['[]'],
        parts: [{ key: '[]', payload: '{}' }]
      }
    })
    expect(exportProfileStateJson(db)).toBe('{"remoteLayoutSnapshots":{},"other":1}')
  } finally {
    db.close()
  }
})

it('rolls back the snapshot and other domains together when its commit fails', () => {
  const db = open()
  try {
    importProfileStateJson(db, '{"remoteLayoutSnapshots":{},"other":1}')
    db.exec(
      "CREATE TRIGGER refuse_parts BEFORE INSERT ON profile_state_document_parts BEGIN SELECT RAISE(ABORT, 'disk refused'); END"
    )
    expect(() =>
      writeProfileStateDomains(db, {
        expectedRevision: 1,
        replacements: [{ domain: 'other', payload: '2' }],
        partsUpdate: {
          domain: 'remoteLayoutSnapshots',
          order: ['["env","workspaces","a"]'],
          parts: [{ key: '["env","workspaces","a"]', payload: '{"tabs":[]}' }]
        }
      })
    ).toThrow('disk refused')
    expect(exportProfileStateJson(db)).toBe('{"remoteLayoutSnapshots":{},"other":1}')
  } finally {
    db.close()
  }
})
