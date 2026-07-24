import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  truncateSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultPersistedState } from '../../shared/constants'
import { NodeFileReadTooLargeError } from '../../shared/node-bounded-file-reader'
import { JsonStringifyByteLimitError } from '../../shared/node-bounded-json-stringify'
import { getOrcaProfileDataFile } from './profile-index-store'
import { readProfileState, writeProfileState } from './profile-project-state-file'

vi.mock('electron', () => ({
  app: {
    getPath: () => ''
  }
}))

describe('profile project state file bounds', () => {
  let userDataPath = ''
  const profileId = 'work'

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-profile-state-bounds-'))
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('round-trips ordinary state with compact JSON semantics unchanged', () => {
    const state = getDefaultPersistedState('/Users/tester')
    state.settings.theme = 'dark'
    const native = JSON.stringify(state)

    writeProfileState(profileId, userDataPath, state, Buffer.byteLength(native))

    expect(readFileSync(getOrcaProfileDataFile(profileId, userDataPath), 'utf8')).toBe(native)
    expect(readProfileState(profileId, userDataPath).settings.theme).toBe('dark')
  })

  it('rejects a profile read one byte over its limit before parsing', () => {
    const dataFile = getOrcaProfileDataFile(profileId, userDataPath)
    mkdirSync(dirname(dataFile), { recursive: true })
    writeFileSync(dataFile, '')
    truncateSync(dataFile, 1025)

    expect(() => readProfileState(profileId, userDataPath, 1024)).toThrow(NodeFileReadTooLargeError)
  })

  it('leaves the prior profile and no temp file when output exceeds its limit', () => {
    const state = getDefaultPersistedState('/Users/tester')
    writeProfileState(profileId, userDataPath, state)
    const dataFile = getOrcaProfileDataFile(profileId, userDataPath)
    const prior = readFileSync(dataFile)
    state.settings.theme = 'light'
    const nextBytes = Buffer.byteLength(JSON.stringify(state))

    expect(() => writeProfileState(profileId, userDataPath, state, nextBytes - 1)).toThrow(
      JsonStringifyByteLimitError
    )
    expect(readFileSync(dataFile)).toEqual(prior)
    expect(readdirSync(dirname(dataFile)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
})
