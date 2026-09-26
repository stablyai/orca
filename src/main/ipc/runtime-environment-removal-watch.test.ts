import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer } from '../../shared/pairing'
import {
  addEnvironmentFromPairingCode,
  getEnvironmentStorePath,
  removeEnvironment
} from '../../shared/runtime-environment-store'
import {
  isRuntimeEnvironmentRemoved,
  noteRuntimeEnvironmentStored,
  retireRemovedRuntimeEnvironment,
  setRuntimeEnvironmentRemovalWatch
} from './runtime-environment-removal-watch'

const tempDirs: string[] = []

function createStore(): { userDataPath: string; environmentId: string } {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-removal-watch-'))
  tempDirs.push(userDataPath)
  const environment = addEnvironmentFromPairingCode(userDataPath, {
    name: 'desk',
    pairingCode: encodePairingOffer({
      v: 2,
      endpoint: 'ws://127.0.0.1:6768',
      deviceToken: 'device-token',
      publicKeyB64: Buffer.from(new Uint8Array(32).fill(1)).toString('base64')
    })
  })
  return { userDataPath, environmentId: environment.id }
}

afterEach(() => {
  setRuntimeEnvironmentRemovalWatch(null)
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('runtime environment removal watch', () => {
  it('reports a stored environment as present', () => {
    const { userDataPath, environmentId } = createStore()
    setRuntimeEnvironmentRemovalWatch({ getUserDataPath: () => userDataPath, retire: vi.fn() })

    expect(isRuntimeEnvironmentRemoved(environmentId)).toBe(false)
  })

  it('never judges an environment the watched store has never listed', () => {
    const { userDataPath } = createStore()
    setRuntimeEnvironmentRemovalWatch({ getUserDataPath: () => userDataPath, retire: vi.fn() })

    // Why: an id resolved from another user-data path is absent here for reasons unrelated to removal.
    expect(isRuntimeEnvironmentRemoved('environment-from-another-path')).toBe(false)
  })

  it('reports an environment the CLI removed from the store', () => {
    const { userDataPath, environmentId } = createStore()
    setRuntimeEnvironmentRemovalWatch({ getUserDataPath: () => userDataPath, retire: vi.fn() })
    noteRuntimeEnvironmentStored(environmentId)
    removeEnvironment(userDataPath, environmentId)

    expect(isRuntimeEnvironmentRemoved(environmentId)).toBe(true)
  })

  it('judges a removal seen only through repeated checks, with no resolve recorded', () => {
    const { userDataPath, environmentId } = createStore()
    setRuntimeEnvironmentRemovalWatch({ getUserDataPath: () => userDataPath, retire: vi.fn() })

    // Why no note call: a liveness tick observing the id still listed is the only evidence a
    // connection gets when its construction-time observation never landed.
    expect(isRuntimeEnvironmentRemoved(environmentId)).toBe(false)
    removeEnvironment(userDataPath, environmentId)

    expect(isRuntimeEnvironmentRemoved(environmentId)).toBe(true)
  })

  it('records a resolve that already succeeded, even once the store no longer lists it', () => {
    const { userDataPath, environmentId } = createStore()
    setRuntimeEnvironmentRemovalWatch({ getUserDataPath: () => userDataPath, retire: vi.fn() })
    // Why removed first: this is the race -- the caller resolved, the CLI removed, and only then
    // does the observation get recorded. Re-reading the store here would find nothing.
    removeEnvironment(userDataPath, environmentId)
    noteRuntimeEnvironmentStored(environmentId, userDataPath)

    expect(isRuntimeEnvironmentRemoved(environmentId)).toBe(true)
  })

  it('ignores a resolve that came from a different user-data path', () => {
    const { userDataPath, environmentId } = createStore()
    const foreignUserDataPath = mkdtempSync(join(tmpdir(), 'orca-removal-watch-foreign-'))
    tempDirs.push(foreignUserDataPath)
    setRuntimeEnvironmentRemovalWatch({ getUserDataPath: () => userDataPath, retire: vi.fn() })
    removeEnvironment(userDataPath, environmentId)
    noteRuntimeEnvironmentStored(environmentId, foreignUserDataPath)

    expect(isRuntimeEnvironmentRemoved(environmentId)).toBe(false)
  })

  it('accepts a watched path written with a trailing separator', () => {
    const { userDataPath, environmentId } = createStore()
    setRuntimeEnvironmentRemovalWatch({ getUserDataPath: () => userDataPath, retire: vi.fn() })
    removeEnvironment(userDataPath, environmentId)
    noteRuntimeEnvironmentStored(environmentId, `${userDataPath}${sep}`)

    expect(isRuntimeEnvironmentRemoved(environmentId)).toBe(true)
  })

  it('forgets recorded environments when the watch is replaced', () => {
    const { userDataPath, environmentId } = createStore()
    setRuntimeEnvironmentRemovalWatch({ getUserDataPath: () => userDataPath, retire: vi.fn() })
    noteRuntimeEnvironmentStored(environmentId)
    removeEnvironment(userDataPath, environmentId)
    setRuntimeEnvironmentRemovalWatch({ getUserDataPath: () => userDataPath, retire: vi.fn() })

    expect(isRuntimeEnvironmentRemoved(environmentId)).toBe(false)
  })

  it('treats a missing store as unknown rather than removed', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-removal-watch-'))
    tempDirs.push(userDataPath)
    setRuntimeEnvironmentRemovalWatch({ getUserDataPath: () => userDataPath, retire: vi.fn() })

    expect(isRuntimeEnvironmentRemoved('environment-a')).toBe(false)
  })

  it('treats an unreadable store as unknown rather than removed', () => {
    const { userDataPath, environmentId } = createStore()
    // Why: an unclean exit can leave the store NUL-filled (#18766); that must not retire anything.
    writeFileSync(getEnvironmentStorePath(userDataPath), Buffer.alloc(64))
    setRuntimeEnvironmentRemovalWatch({ getUserDataPath: () => userDataPath, retire: vi.fn() })

    expect(isRuntimeEnvironmentRemoved(environmentId)).toBe(false)
  })

  it('answers present and retires nothing before a watch is installed', () => {
    expect(isRuntimeEnvironmentRemoved('environment-a')).toBe(false)
    expect(() => retireRemovedRuntimeEnvironment('environment-a')).not.toThrow()
  })

  it('retires a removed environment through the injected teardown', () => {
    const { userDataPath } = createStore()
    const retire = vi.fn().mockResolvedValue(undefined)
    setRuntimeEnvironmentRemovalWatch({ getUserDataPath: () => userDataPath, retire })

    retireRemovedRuntimeEnvironment('environment-a')

    expect(retire).toHaveBeenCalledWith('environment-a')
  })

  it('survives a teardown that rejects', async () => {
    const { userDataPath } = createStore()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setRuntimeEnvironmentRemovalWatch({
      getUserDataPath: () => userDataPath,
      retire: () => Promise.reject(new Error('teardown failed'))
    })

    retireRemovedRuntimeEnvironment('environment-a')
    await Promise.resolve()

    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
