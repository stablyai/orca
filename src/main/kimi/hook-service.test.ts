import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { KimiHookService } from './hook-service'

describe('KimiHookService', () => {
  let home: string
  let configPath: string
  const service = new KimiHookService()

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'kimi-home-'))
    process.env.KIMI_CODE_HOME = home
    configPath = join(home, 'config.toml')
  })

  afterEach(() => {
    delete process.env.KIMI_CODE_HOME
    rmSync(home, { recursive: true, force: true })
  })

  it('reports not_installed for a config without the managed block', () => {
    writeFileSync(configPath, 'default_model = "kimi-code/kimi-for-coding"\n')
    expect(service.getStatus().state).toBe('not_installed')
  })

  it('installs the managed hooks block while preserving user config', () => {
    writeFileSync(configPath, 'default_model = "kimi-code/kimi-for-coding"\n')

    const status = service.install()
    expect(status.state).toBe('installed')
    expect(status.managedHooksPresent).toBe(true)

    const content = readFileSync(configPath, 'utf-8')
    expect(content).toContain('default_model = "kimi-code/kimi-for-coding"')
    expect(content).toContain('# >>> orca-managed-hooks >>>')
    for (const event of [
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'PostToolUseFailure',
      'PermissionRequest',
      'PermissionResult',
      'Stop',
      'StopFailure'
    ]) {
      expect(content).toContain(`event = "${event}"`)
    }
    expect(content).toContain('kimi-hook')
  })

  it('is idempotent — reinstalling does not duplicate the block', () => {
    writeFileSync(configPath, '')
    service.install()
    service.install()
    const content = readFileSync(configPath, 'utf-8')
    expect(content.split('# >>> orca-managed-hooks >>>').length - 1).toBe(1)
  })

  it('remove strips the managed block but keeps user config', () => {
    writeFileSync(configPath, 'theme = "dark"\n')
    service.install()
    const removed = service.remove()
    expect(removed.state).toBe('not_installed')
    const content = readFileSync(configPath, 'utf-8')
    expect(content).toContain('theme = "dark"')
    expect(content).not.toContain('orca-managed-hooks')
  })
})
