import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deleteLegacyWslHostWakeList } from './wsl-host-early-wake'

describe('the old WSL host early-wake list', () => {
  let userDataPath: string

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-wsl-wake-list-'))
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('is deleted at launch, so no build boots a distro from it again (E9)', () => {
    const wakeList = join(userDataPath, 'orca-wsl-host-wake.json')
    writeFileSync(wakeList, JSON.stringify({ version: 1, distros: ['Ubuntu'] }))

    deleteLegacyWslHostWakeList(userDataPath)

    expect(existsSync(wakeList)).toBe(false)
    expect(() => deleteLegacyWslHostWakeList(userDataPath)).not.toThrow()
  })
})
