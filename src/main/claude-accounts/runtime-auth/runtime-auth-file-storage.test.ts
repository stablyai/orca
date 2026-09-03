import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClaudeRuntimeAuthFileStorage } from './runtime-auth-file-storage'

const readFaults = vi.hoisted(() => {
  const denied = new Set<string>()
  return {
    deny(path: string): void {
      denied.add(path)
    },
    reset(): void {
      denied.clear()
    },
    check(target: unknown): void {
      if (typeof target !== 'string' || !denied.has(target)) {
        return
      }
      const error: NodeJS.ErrnoException = new Error(`EPERM: read '${target}'`)
      error.code = 'EPERM'
      throw error
    }
  }
})

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  const originalRead = actual.readFileSync as (...args: unknown[]) => unknown
  const readFileSync = Object.assign((...args: unknown[]): unknown => {
    readFaults.check(args[0])
    return originalRead(...args)
  }, originalRead)
  const patched = { ...actual, readFileSync }
  return { ...patched, default: patched }
})

vi.mock('electron', () => ({ app: { getPath: () => '/unused' } }))

const realFs = await vi.importActual<typeof NodeFs>('node:fs')
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

class TestClaudeRuntimeAuthFileStorage extends ClaudeRuntimeAuthFileStorage {
  constructor() {
    super({} as never)
  }

  writeCredentials(contents: string): void {
    this.writeRuntimeCredentials(contents)
  }

  readObject(targetPath: string): Record<string, unknown> | null {
    return this.readJsonObject(targetPath)
  }
}

describe('ClaudeRuntimeAuthFileStorage filesystem observations', () => {
  let configDir: string

  beforeEach(() => {
    readFaults.reset()
    configDir = realFs.mkdtempSync(join(realFs.realpathSync.native(tmpdir()), 'orca-claude-auth-'))
    process.env.CLAUDE_CONFIG_DIR = configDir
  })

  afterEach(() => {
    readFaults.reset()
    realFs.rmSync(configDir, { recursive: true, force: true })
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    }
  })

  it('does not overwrite credentials that it cannot read', () => {
    const credentialsPath = join(configDir, '.credentials.json')
    realFs.writeFileSync(credentialsPath, 'newer-runtime-credentials', 'utf-8')
    readFaults.deny(credentialsPath)

    expect(() => new TestClaudeRuntimeAuthFileStorage().writeCredentials('stale-copy')).toThrow(
      expect.objectContaining({ code: 'EPERM' })
    )
    expect(realFs.readFileSync(credentialsPath, 'utf-8')).toBe('newer-runtime-credentials')
  })

  it('does not treat an unreadable JSON store as empty', () => {
    const configPath = join(configDir, '.claude.json')
    realFs.writeFileSync(configPath, '{"oauthAccount":{"accountUuid":"existing"}}', 'utf-8')
    readFaults.deny(configPath)

    expect(new TestClaudeRuntimeAuthFileStorage().readObject(configPath)).toBeNull()
  })
})
