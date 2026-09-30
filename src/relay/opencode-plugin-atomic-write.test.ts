import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as NodeFs from 'node:fs'

const { directWrites } = vi.hoisted(() => {
  const writes: string[] = []
  return { directWrites: writes }
})

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      directWrites.push(String(args[0]))
      return actual.writeFileSync(...args)
    }
  }
})

import { installOpenCodePluginInCanonicalConfig } from './opencode-canonical-config'

// Why: OpenCode 2 reloads a plugin on mtime change; a reload must never see the file missing or half-written.
describe('relay canonical OpenCode plugin write', () => {
  let homeDir: string

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'opencode-atomic-'))
  })

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true })
  })

  it('replaces a stale plugin without writing to its path in place', () => {
    const env = { XDG_CONFIG_HOME: join(homeDir, 'xdg') }
    const pluginsDir = join(homeDir, 'xdg', 'opencode', 'plugins')
    const pluginPath = join(pluginsDir, 'orca-opencode2-status.js')
    mkdirSync(pluginsDir, { recursive: true })
    writeFileSync(pluginPath, 'stale plugin')
    directWrites.length = 0

    expect(installOpenCodePluginInCanonicalConfig('fresh plugin', 'opencode2', env, homeDir)).toBe(
      true
    )

    expect(readFileSync(pluginPath, 'utf8')).toBe('fresh plugin')
    expect(directWrites).not.toContain(pluginPath)
    expect(readdirSync(pluginsDir)).toEqual(['orca-opencode2-status.js'])
  })
})
