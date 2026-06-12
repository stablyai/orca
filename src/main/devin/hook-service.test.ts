import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'

const { homedirMock } = vi.hoisted(() => ({
  homedirMock: vi.fn<() => string>()
}))

vi.mock('os', async () => {
  const actual = (await vi.importActual('os')) as Record<string, unknown>
  return {
    ...actual,
    homedir: homedirMock
  }
})

import { DevinHookService } from './hook-service'

describe('DevinHookService', () => {
  let homeDir: string

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'orca-devin-home-'))
    homedirMock.mockReturnValue(homeDir)
  })

  afterEach(() => {
    vi.clearAllMocks()
    rmSync(homeDir, { recursive: true, force: true })
  })

  it('installs managed hooks into user Devin config and posts to /hook/devin', () => {
    const status = new DevinHookService().install()

    expect(status.state).toBe('installed')
    expect(status.agent).toBe('devin')
    expect(status.configPath).toBe(join(homeDir, '.config', 'devin', 'config.json'))
    expect(status.managedHooksPresent).toBe(true)

    const config = JSON.parse(
      readFileSync(join(homeDir, '.config', 'devin', 'config.json'), 'utf8')
    ) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>
      agent?: { model: string }
    }
    expect(config.hooks.UserPromptSubmit[0].hooks[0].command).toContain('devin-hook')
    const script = readFileSync(join(homeDir, '.orca', 'agent-hooks', 'devin-hook.sh'), 'utf8')
    expect(script).toContain('/hook/devin')
  })

  it('preserves unrelated keys in Devin config when installing hooks', () => {
    const configPath = join(homeDir, '.config', 'devin', 'config.json')
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(
      configPath,
      `${JSON.stringify({ permissions: { mode: 'normal' }, hooks: {} }, null, 2)}\n`
    )

    new DevinHookService().install()

    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      permissions: { mode: string }
      hooks: Record<string, unknown>
    }
    expect(config.permissions.mode).toBe('normal')
    expect(config.hooks.UserPromptSubmit).toBeDefined()
  })
})