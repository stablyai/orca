import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  isMissingProviderExecutable,
  providerLaunchFolderMissing,
  providerSpawnAbsence,
  withProviderSpawnAbsence
} from './provider-executable-missing'

// Node reports a spawn whose working folder is gone as ENOENT naming the command, like a missing CLI.
describe('a spawn ENOENT that names the command', () => {
  let folder: string
  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'orca-provider-spawn-'))
  })
  afterEach(() => {
    rmSync(folder, { recursive: true, force: true })
  })
  const direct = () =>
    Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT', path: 'claude' })
  // The supervisor's report carries no path.
  const reported = () => Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })

  it('blames a deleted working folder, not the CLI', () => {
    const gone = join(folder, 'deleted-worktree')
    for (const error of [direct(), reported()]) {
      expect(providerSpawnAbsence(error, 'claude', gone)).toBe('launchFolder')
      expect(isMissingProviderExecutable(error, 'claude', gone)).toBe(false)
    }
  })

  it('still blames the CLI when the working folder exists, or none was given', () => {
    for (const error of [direct(), reported()]) {
      expect(providerSpawnAbsence(error, 'claude', folder)).toBe('executable')
      expect(providerSpawnAbsence(error, 'claude')).toBe('executable')
    }
  })

  it('blames neither for another error, or an ENOENT naming another file', () => {
    const gone = join(folder, 'deleted-worktree')
    expect(
      providerSpawnAbsence(Object.assign(new Error('denied'), { code: 'EACCES' }), 'claude', gone)
    ).toBeNull()
    expect(
      providerSpawnAbsence(
        Object.assign(new Error('no node'), { code: 'ENOENT', path: '/usr/bin/node' }),
        'claude',
        gone
      )
    ).toBeNull()
  })

  it('carries the folder verdict on the error the chat reports', () => {
    const error = withProviderSpawnAbsence(new Error('claude exited (code 127)'), 'launchFolder')
    expect(providerLaunchFolderMissing(new Error('wrapped', { cause: error }))).toBe(true)
    expect(providerLaunchFolderMissing(withProviderSpawnAbsence(new Error('x'), null))).toBe(false)
  })
})
