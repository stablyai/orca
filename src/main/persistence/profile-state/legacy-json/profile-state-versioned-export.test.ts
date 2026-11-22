import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { durableWriteTempPath, writeFileDurableSync } from '../../../filesystem/durable-file-write'
import { writeVersionedProfileStateExport } from './profile-state-versioned-export'

vi.mock('node:fs', async (original) => ({ ...(await original<typeof fs>()) }))

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'orca-versioned-export-'))
  roots.push(root)
  const dataFile = join(root, 'orca-data.json')
  const source = '{"settings":{"theme":"dark"}}'
  const write = (revision = 4) =>
    writeVersionedProfileStateExport(dataFile, (staging) => {
      writeFileDurableSync(durableWriteTempPath(staging), staging, source)
      return revision
    })
  return { root, write }
}

describe('immutable versioned profile exports', () => {
  it('retains only five successfully published exports and leaves unrelated entries alone', () => {
    const { root, write } = fixture()
    for (let revision = 1; revision <= 7; revision++) {
      expect(write(revision)).toBe(revision)
    }
    const reservedDirectory = join(root, 'orca-data.json.sqlite-export.1.json')
    fs.mkdirSync(reservedDirectory)
    const unrelated = join(root, 'orca-data.json.sqlite-export.notes.json')
    fs.writeFileSync(unrelated, 'keep')
    write(8)
    expect(fs.readdirSync(root).sort()).toEqual([
      'orca-data.json.sqlite-export.1.json',
      ...[4, 5, 6, 7, 8].map((revision) => `orca-data.json.sqlite-export.${revision}.json`),
      'orca-data.json.sqlite-export.notes.json'
    ])
    expect(fs.lstatSync(reservedDirectory).isDirectory()).toBe(true)
  })
})
