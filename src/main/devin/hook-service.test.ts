import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse as parseJsonc } from 'jsonc-parser'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

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
import { applyDevinManagedHooks, getDevinConfigPath, getDevinManagedCommand } from './hook-settings'

describe('DevinHookService', () => {
  let homeDir: string

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'orca-devin-home-'))
    homedirMock.mockReturnValue(homeDir)
    vi.stubEnv('APPDATA', join(homeDir, 'AppData', 'Roaming'))
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
    vi.unstubAllEnvs()
    rmSync(homeDir, { recursive: true, force: true })
  })

  it('keeps user comments and unrelated formatting when installing and removing', () => {
    const configPath = getDevinConfigPath()
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(
      configPath,
      `{
  // keep me: chosen deliberately
  "permissions": { "mode": "normal" },
  /* block comment */
  "hooks": {
    // the user's own hook
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "mine.sh" }] }]
  }
}
`
    )

    const service = new DevinHookService()
    service.install()

    const installed = readFileSync(configPath, 'utf8')
    expect(installed).toContain('// keep me: chosen deliberately')
    expect(installed).toContain('/* block comment */')
    expect(installed).toContain("// the user's own hook")
    expect(installed).toContain('mine.sh')
    expect(parseJsonc(installed).permissions.mode).toBe('normal')
    expect(parseJsonc(installed).hooks.UserPromptSubmit).toBeDefined()

    service.remove()

    const removed = readFileSync(configPath, 'utf8')
    expect(removed).toContain('// keep me: chosen deliberately')
    expect(removed).toContain('mine.sh')
    expect(parseJsonc(removed).hooks.UserPromptSubmit).toBeUndefined()
  })

  it('registers a forward-slash cmd path on Windows and replaces the legacy backslash entry', () => {
    const previous = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      const scriptPath = 'C:\\Users\\ada\\.orca\\agent-hooks\\devin-hook.cmd'
      const command = getDevinManagedCommand(scriptPath)
      // Forward slashes survive Git Bash path handling.
      expect(command).toBe('C:/Users/ada/.orca/agent-hooks/devin-hook.cmd')
      // UNC paths retain the encoded launcher because they have no drive letter.
      expect(
        getDevinManagedCommand('\\\\server\\share\\ada\\.orca\\agent-hooks\\devin-hook.cmd')
      ).toMatch(/ -EncodedCommand \S+$/)

      const next = applyDevinManagedHooks(
        {
          hooks: {
            Stop: [
              { hooks: [{ type: 'command', command: scriptPath }] },
              { hooks: [{ type: 'command', command: 'C:\\tools\\user-hook.cmd' }] }
            ]
          }
        },
        command,
        'devin-hook.cmd'
      )
      expect(next.hooks?.Stop?.flatMap((definition) => definition.hooks ?? [])).toEqual([
        { type: 'command', command: 'C:\\tools\\user-hook.cmd' },
        expect.objectContaining({ command })
      ])
    } finally {
      Object.defineProperty(process, 'platform', { value: previous })
    }
  })
})
