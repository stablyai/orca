import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { delimiter, join } from 'path'
import {
  resetLanguageServerDiscoveryCache,
  resolveLanguageServerCommand
} from './language-server-registry'

function createFakeCommand(
  dir: string,
  name: string,
  exitCode = 0,
  options: { counterPath?: string } = {}
): string {
  const isWindows = process.platform === 'win32'
  const commandPath = join(dir, isWindows ? `${name}.cmd` : name)
  writeFileSync(
    commandPath,
    isWindows
      ? `@echo off\r\n${options.counterPath ? `>> "${options.counterPath}" echo x\r\n` : ''}exit /b ${exitCode}\r\n`
      : `#!/bin/sh\n${options.counterPath ? `printf 'x\\n' >> "${options.counterPath}"\n` : ''}exit ${exitCode}\n`
  )
  if (!isWindows) {
    chmodSync(commandPath, 0o755)
  }
  return commandPath
}

function readInvocationCount(path: string): number {
  try {
    return readFileSync(path, 'utf-8').split(/\r?\n/).filter(Boolean).length
  } catch {
    return 0
  }
}

describe('language-server-registry', () => {
  let originalPath: string | undefined
  let dir: string

  beforeEach(() => {
    originalPath = process.env.PATH
    dir = mkdtempSync(join(tmpdir(), 'orca-lsp-registry-'))
    process.env.PATH = originalPath ? `${dir}${delimiter}${originalPath}` : dir
    resetLanguageServerDiscoveryCache()
  })

  afterEach(() => {
    process.env.PATH = originalPath
    vi.restoreAllMocks()
    resetLanguageServerDiscoveryCache()
    rmSync(dir, { recursive: true, force: true })
  })

  it('discovers configured language servers from PATH', async () => {
    const commandPath = createFakeCommand(dir, 'rust-analyzer')

    await expect(resolveLanguageServerCommand('rust')).resolves.toEqual({
      ok: true,
      command: { command: commandPath, args: [] }
    })
  })

  it('dedupes concurrent discovery probes for the same language', async () => {
    const counterPath = join(dir, 'probe-count.txt')
    const commandPath = createFakeCommand(dir, 'rust-analyzer', 0, { counterPath })

    await expect(
      Promise.all([resolveLanguageServerCommand('rust'), resolveLanguageServerCommand('rust')])
    ).resolves.toEqual([
      { ok: true, command: { command: commandPath, args: [] } },
      { ok: true, command: { command: commandPath, args: [] } }
    ])
    expect(readInvocationCount(counterPath)).toBe(1)
  })

  it('rejects configured language servers that fail their startup probe', async () => {
    createFakeCommand(dir, 'rust-analyzer', 1)

    const result = await resolveLanguageServerCommand('rust')

    expect(result.ok).toBe(false)
    if (result.ok) {
      throw new Error('expected rust-analyzer discovery to fail')
    }
    expect(result.reason).toContain('rust-analyzer')
  })

  it('rechecks missing language servers on the next retry', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const missing = await resolveLanguageServerCommand('rust')
    expect(missing.ok).toBe(false)

    const commandPath = createFakeCommand(dir, 'rust-analyzer')

    await expect(resolveLanguageServerCommand('rust')).resolves.toEqual(missing)

    now.mockReturnValue(2_001)
    await expect(resolveLanguageServerCommand('rust')).resolves.toEqual({
      ok: true,
      command: { command: commandPath, args: [] }
    })
  })

  it('does not fall back to the legacy TypeScript language server', async () => {
    createFakeCommand(dir, 'typescript-language-server')

    const result = await resolveLanguageServerCommand('typescript')

    expect(result.ok).toBe(false)
    if (result.ok) {
      throw new Error('expected TypeScript LSP discovery to fail')
    }
    expect(result.reason).not.toContain('typescript-language-server')
  })
})
