import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { durableWriteTempPath, writeFileDurableSync } from '../../durable-file-write'
import { profileStateJsonExportPath } from './profile-state-export-path'
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
  const target = profileStateJsonExportPath(dataFile, 4)
  const source = '{"settings":{"theme":"dark"}}'
  const write = (revision = 4) =>
    writeVersionedProfileStateExport(dataFile, (staging) => {
      writeFileDurableSync(durableWriteTempPath(staging), staging, source)
      return revision
    })
  return { root, target, source, write }
}

describe('immutable versioned profile exports', () => {
  it('publishes once and accepts repeated identical exports', () => {
    const { root, target, source, write } = fixture()
    expect(write()).toBe(4)
    expect(write()).toBe(4)
    expect(fs.readFileSync(target, 'utf8')).toBe(source)
    expect(fs.readdirSync(root)).toEqual([basename(target)])
  })

  it('does not retain an empty profile export', () => {
    const { root, write } = fixture()
    expect(write(0)).toBeUndefined()
    expect(fs.readdirSync(root)).toEqual([])
  })

  it.each(['identical', 'divergent'] as const)(
    'preserves a concurrently published %s revision',
    (kind) => {
      const { root, target, source, write } = fixture()
      const competing = kind === 'identical' ? source : '{"settings":{"theme":"light"}}'
      let raced = false
      const publishCompetitor = (path: fs.PathLike) => {
        if (!raced && path === target) {
          raced = true
          fs.writeFileSync(target, competing)
        }
      }
      const rename = fs.renameSync
      vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        publishCompetitor(to)
        rename(from, to)
      })
      const link = fs.linkSync
      vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
        publishCompetitor(to)
        link(from, to)
      })

      if (kind === 'identical') {
        expect(write()).toBe(4)
      } else {
        expect(write).toThrow('already exists with different content')
      }
      expect(raced).toBe(true)
      expect(fs.readFileSync(target, 'utf8')).toBe(competing)
      expect(fs.readdirSync(root)).toEqual([basename(target)])
    }
  )
})
