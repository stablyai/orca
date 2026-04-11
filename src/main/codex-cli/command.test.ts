import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveCodexCommand } from './command'

function makeExecutable(path: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '')
}

describe('resolveCodexCommand', () => {
  afterEach(() => {
    delete process.env.PATH
    delete process.env.Path
  })

  it('prefers Codex already present on PATH', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-codex-command-'))
    const pathDir = join(root, 'bin')
    const commandPath = join(pathDir, 'codex')
    makeExecutable(commandPath)

    expect(resolveCodexCommand({ platform: 'darwin', pathEnv: pathDir, homePath: root })).toBe(
      commandPath
    )
  })

  it('falls back to the newest nvm-installed Codex when PATH misses it', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-codex-command-'))
    const v22Path = join(root, '.nvm', 'versions', 'node', 'v22.14.0', 'bin', 'codex')
    const v24Path = join(root, '.nvm', 'versions', 'node', 'v24.13.0', 'bin', 'codex')
    makeExecutable(v22Path)
    makeExecutable(v24Path)

    expect(resolveCodexCommand({ platform: 'darwin', pathEnv: '', homePath: root })).toBe(v24Path)
  })

  it('returns the bare command when no filesystem candidate exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-codex-command-'))

    expect(resolveCodexCommand({ platform: 'linux', pathEnv: '', homePath: root })).toBe('codex')
  })
})
