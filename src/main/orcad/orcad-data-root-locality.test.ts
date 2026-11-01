import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { orcadDataRootIsOnLocalDisk } from './orcad-data-root-locality'

describe('orcadDataRootIsOnLocalDisk', () => {
  it.runIf(process.platform === 'linux' || process.platform === 'darwin')(
    'recognises a local temp directory, and refuses a path it cannot inspect',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'orcad-locality-'))
      try {
        expect(orcadDataRootIsOnLocalDisk(root)).toBe(true)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
      expect(orcadDataRootIsOnLocalDisk(join(root, 'missing'))).toBe(false)
    }
  )

  it('treats a Windows UNC data root as reachable from other machines', () => {
    expect(orcadDataRootIsOnLocalDisk('\\\\filer\\home\\orca', 'win32')).toBe(false)
    expect(orcadDataRootIsOnLocalDisk('\\\\?\\UNC\\filer\\home\\orca', 'win32')).toBe(false)
    expect(orcadDataRootIsOnLocalDisk('C:\\Users\\u\\AppData\\Roaming\\orca', 'win32')).toBe(true)
    expect(orcadDataRootIsOnLocalDisk('\\\\?\\C:\\Users\\u\\orca', 'win32')).toBe(true)
  })
})
