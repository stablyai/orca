import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as NodeFs from 'node:fs'
import { setAppEnvironment } from '../../shared/app-environment'

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

import { OpenCodeHookService, _internals } from './hook-service'
import { resolveOpenCodeConfigDirectory } from '../../shared/opencode-config-directory'

// Why: OpenCode 2 reloads a plugin on mtime change; a reload must never see it truncated mid-write.
describe('OpenCodeHookService canonical plugin write', () => {
  const ptyId = 'c0ffee00-0000-4000-8000-000000000000'
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME
  let userDataDir: string
  let pluginPath: string

  beforeAll(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'orca-opencode-atomic-'))
    process.env.XDG_CONFIG_HOME = userDataDir
    setAppEnvironment({
      getPath: () => userDataDir,
      getAppPath: () => process.cwd(),
      getVersion: () => '0.0.0-test',
      isPackaged: () => false,
      onWillQuit: () => {},
      exit: () => {},
      getAppMetrics: () => []
    })
  })

  afterAll(() => {
    if (originalXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome
    }
    rmSync(userDataDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    const pluginsDir = join(resolveOpenCodeConfigDirectory(), 'plugins')
    rmSync(pluginsDir, { recursive: true, force: true })
    mkdirSync(pluginsDir, { recursive: true })
    pluginPath = join(pluginsDir, 'orca-opencode-status.js')
    directWrites.length = 0
  })

  it('replaces a stale plugin without writing to its path in place', () => {
    writeFileSync(pluginPath, 'stale plugin')
    directWrites.length = 0

    new OpenCodeHookService().buildPtyEnv(ptyId)

    expect(readFileSync(pluginPath, 'utf8')).toBe(_internals.getOpenCodePluginSource())
    expect(directWrites).not.toContain(pluginPath)
    expect(readdirSync(join(pluginPath, '..'))).toEqual(['orca-opencode-status.js'])
  })

  it.skipIf(process.platform === 'win32')(
    'keeps a symlinked plugin linked and replaces its target atomically',
    () => {
      const targetPath = join(userDataDir, 'dotfiles-orca-opencode-status.js')
      writeFileSync(targetPath, 'stale plugin')
      symlinkSync(targetPath, pluginPath)
      directWrites.length = 0

      new OpenCodeHookService().buildPtyEnv(ptyId)

      expect(lstatSync(pluginPath).isSymbolicLink()).toBe(true)
      expect(readFileSync(targetPath, 'utf8')).toBe(_internals.getOpenCodePluginSource())
      expect(directWrites).not.toContain(pluginPath)
      expect(directWrites).not.toContain(realpathSync(targetPath))
      rmSync(targetPath, { force: true })
    }
  )
})
