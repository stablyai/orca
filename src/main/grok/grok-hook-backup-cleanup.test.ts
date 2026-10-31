import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { homedirMock } = vi.hoisted(() => ({ homedirMock: vi.fn<() => string>() }))
vi.mock('os', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('os')),
  homedir: homedirMock
}))

import { GrokHookService } from './hook-service'
import { removeGrokHookBackupEntries } from './grok-hook-backup-cleanup'

const USER_HOOK = { matcher: '*', hooks: [{ type: 'command', command: 'my-own-hook' }] }

describe('the Grok hook file backup after removal', () => {
  let homeDir: string
  let configPath: string
  let backupPath: string

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'orca-grok-backup-'))
    homedirMock.mockReturnValue(homeDir)
    configPath = join(homeDir, '.grok', 'hooks', 'orca-status.json')
    backupPath = `${configPath}.bak`
  })

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it.each(['sync', 'quit'] as const)(
    'deletes a backup that held only Orca entries (%s path)',
    async (path) => {
      const service = new GrokHookService()
      expect(service.install().state).toBe('installed')
      copyFileSync(configPath, backupPath)

      if (path === 'sync') {
        service.remove()
      } else {
        await service.removeAsync()
      }

      expect(existsSync(configPath)).toBe(false)
      expect(existsSync(backupPath)).toBe(false)
    }
  )

  it("strips Orca's entries from a backup that also holds the user's own", () => {
    const service = new GrokHookService()
    expect(service.install().state).toBe('installed')
    const config: { hooks: Record<string, unknown[]> } = JSON.parse(
      readFileSync(configPath, 'utf8')
    )
    config.hooks.UserCustomEvent = [USER_HOOK]
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
    copyFileSync(configPath, backupPath)

    service.remove()

    const backup = readFileSync(backupPath, 'utf8')
    expect(backup).toContain('my-own-hook')
    expect(backup).not.toContain('orca')
  })

  it('leaves a symlinked backup alone', () => {
    const service = new GrokHookService()
    expect(service.install().state).toBe('installed')
    const target = join(homeDir, 'elsewhere.json')
    copyFileSync(configPath, target)
    symlinkSync(target, backupPath)

    removeGrokHookBackupEntries(configPath)

    expect(readFileSync(target, 'utf8')).toContain('orca')
  })

  it('does nothing without a backup', () => {
    expect(() => removeGrokHookBackupEntries(configPath)).not.toThrow()
  })
})
