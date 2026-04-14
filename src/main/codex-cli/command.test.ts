import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveClaudeCommand, resolveCodexCommand } from './command'

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

  it('finds Codex in pnpm global bin on macOS', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-codex-command-'))
    const pnpmPath = join(root, 'Library', 'pnpm', 'codex')
    makeExecutable(pnpmPath)

    expect(resolveCodexCommand({ platform: 'darwin', pathEnv: '', homePath: root })).toBe(pnpmPath)
  })

  it('finds Codex in pnpm global bin on Linux', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-codex-command-'))
    const pnpmPath = join(root, '.local', 'share', 'pnpm', 'codex')
    makeExecutable(pnpmPath)

    expect(resolveCodexCommand({ platform: 'linux', pathEnv: '', homePath: root })).toBe(pnpmPath)
  })

  it('finds Codex in pnpm global bin on Windows', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-codex-command-'))
    const pnpmPath = join(root, 'AppData', 'Local', 'pnpm', 'codex.cmd')
    makeExecutable(pnpmPath)

    expect(resolveCodexCommand({ platform: 'win32', pathEnv: '', homePath: root })).toBe(pnpmPath)
  })

  it('finds Codex in yarn global bin on macOS', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-codex-command-'))
    const yarnPath = join(root, '.yarn', 'bin', 'codex')
    makeExecutable(yarnPath)

    expect(resolveCodexCommand({ platform: 'darwin', pathEnv: '', homePath: root })).toBe(yarnPath)
  })

  it('finds Codex in yarn global bin on Windows', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-codex-command-'))
    const yarnPath = join(root, 'AppData', 'Local', 'Yarn', 'bin', 'codex.cmd')
    makeExecutable(yarnPath)

    expect(resolveCodexCommand({ platform: 'win32', pathEnv: '', homePath: root })).toBe(yarnPath)
  })

  it('finds Codex in bun global bin', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-codex-command-'))
    const bunPath = join(root, '.bun', 'bin', 'codex')
    makeExecutable(bunPath)

    expect(resolveCodexCommand({ platform: 'linux', pathEnv: '', homePath: root })).toBe(bunPath)
  })

  it('finds Codex in bun global bin on Windows', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-codex-command-'))
    const bunPath = join(root, '.bun', 'bin', 'codex.exe')
    makeExecutable(bunPath)

    expect(resolveCodexCommand({ platform: 'win32', pathEnv: '', homePath: root })).toBe(bunPath)
  })

  it('returns the bare command when no filesystem candidate exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-codex-command-'))

    expect(resolveCodexCommand({ platform: 'linux', pathEnv: '', homePath: root })).toBe('codex')
  })
})

describe('resolveClaudeCommand', () => {
  afterEach(() => {
    delete process.env.PATH
    delete process.env.Path
  })

  it('prefers claude already present on PATH', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-claude-command-'))
    const pathDir = join(root, 'bin')
    const commandPath = join(pathDir, 'claude')
    makeExecutable(commandPath)

    expect(resolveClaudeCommand({ platform: 'darwin', pathEnv: pathDir, homePath: root })).toBe(
      commandPath
    )
  })

  it('falls back to the newest nvm-installed claude when PATH misses it', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-claude-command-'))
    const v22Path = join(root, '.nvm', 'versions', 'node', 'v22.14.0', 'bin', 'claude')
    const v24Path = join(root, '.nvm', 'versions', 'node', 'v24.13.0', 'bin', 'claude')
    makeExecutable(v22Path)
    makeExecutable(v24Path)

    expect(resolveClaudeCommand({ platform: 'darwin', pathEnv: '', homePath: root })).toBe(v24Path)
  })

  it('finds claude in pnpm global bin on macOS', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-claude-command-'))
    const pnpmPath = join(root, 'Library', 'pnpm', 'claude')
    makeExecutable(pnpmPath)

    expect(resolveClaudeCommand({ platform: 'darwin', pathEnv: '', homePath: root })).toBe(pnpmPath)
  })

  it('finds claude in yarn global bin', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-claude-command-'))
    const yarnPath = join(root, '.yarn', 'bin', 'claude')
    makeExecutable(yarnPath)

    expect(resolveClaudeCommand({ platform: 'linux', pathEnv: '', homePath: root })).toBe(yarnPath)
  })

  it('finds claude in bun global bin', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-claude-command-'))
    const bunPath = join(root, '.bun', 'bin', 'claude')
    makeExecutable(bunPath)

    expect(resolveClaudeCommand({ platform: 'darwin', pathEnv: '', homePath: root })).toBe(bunPath)
  })

  it('returns the bare command when no filesystem candidate exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-claude-command-'))

    expect(resolveClaudeCommand({ platform: 'linux', pathEnv: '', homePath: root })).toBe('claude')
  })
})
