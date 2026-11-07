import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readHooksJson, wrapWindowsHookCommand } from '../agent-hooks/installer-utils'
import { COPILOT_EVENTS, getManagedCommand } from './copilot-managed-hook-definitions'
import { CopilotHookService } from './hook-service'

let tmpDir: string
let copilotHome: string
let originalCopilotHome: string | undefined
let originalHome: string | undefined
let originalUserProfile: string | undefined

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'orca-copilot-hooks-'))
  copilotHome = join(tmpDir, 'copilot-home')
  originalCopilotHome = process.env.COPILOT_HOME
  originalHome = process.env.HOME
  originalUserProfile = process.env.USERPROFILE
  process.env.COPILOT_HOME = copilotHome
  process.env.HOME = tmpDir
  process.env.USERPROFILE = tmpDir
})

afterEach(() => {
  vi.restoreAllMocks()
  if (originalCopilotHome === undefined) {
    delete process.env.COPILOT_HOME
  } else {
    process.env.COPILOT_HOME = originalCopilotHome
  }
  if (originalHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = originalHome
  }
  if (originalUserProfile === undefined) {
    delete process.env.USERPROFILE
  } else {
    process.env.USERPROFILE = originalUserProfile
  }
  rmSync(tmpDir, { recursive: true, force: true })
})

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(copilotHome, 'hooks', 'orca.json'), 'utf-8'))
}

function makeStaleManagedHookDefinition(): Record<string, unknown> {
  if (process.platform === 'win32') {
    return {
      type: 'command',
      powershell: 'powershell.exe -File C:/old/agent-hooks/copilot-hook.ps1'
    }
  }
  return { type: 'command', bash: '/bin/sh "/old/agent-hooks/copilot-hook.sh"' }
}

describe('CopilotHookService', () => {
  describe('on Windows', () => {
    beforeEach(() => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    })

    it('replaces the legacy .ps1 registration on install and keeps user hooks', () => {
      const legacyPath = join(tmpDir, '.orca', 'agent-hooks', 'copilot-hook.ps1')
      const configPath = join(copilotHome, 'hooks', 'orca.json')
      mkdirSync(join(copilotHome, 'hooks'), { recursive: true })
      const userHook = { type: 'command', powershell: 'Write-Output user-hook', timeoutSec: 3 }
      const legacyHooks = Object.fromEntries(
        COPILOT_EVENTS.map((eventName) => [
          eventName,
          [
            {
              type: 'command',
              powershell: wrapWindowsHookCommand(legacyPath, {
                ORCA_COPILOT_HOOK_EVENT: eventName
              }),
              timeoutSec: 5
            }
          ]
        ])
      )
      legacyHooks.UserPromptSubmit.unshift(userHook)
      writeFileSync(configPath, JSON.stringify({ version: 1, hooks: legacyHooks }, null, 2))
      const service = new CopilotHookService()
      expect(service.getStatus().state).toBe('partial')

      expect(service.install().state).toBe('installed')
      const hooks = readHooksJson(configPath)?.hooks ?? {}
      const scriptPath = join(tmpDir, '.orca', 'agent-hooks', 'copilot-hook.cmd')
      for (const eventName of COPILOT_EVENTS) {
        const managed = {
          type: 'command',
          powershell: getManagedCommand(scriptPath, eventName),
          timeoutSec: 5
        }
        expect(hooks[eventName]).toEqual(
          eventName === 'UserPromptSubmit' ? [userHook, managed] : [managed]
        )
      }
      expect(JSON.stringify(hooks)).not.toContain('copilot-hook.ps1')
      expect(existsSync(scriptPath)).toBe(true)
    })
  })

  it('preserves user-authored hooks and sweeps stale managed entries', () => {
    const configPath = join(copilotHome, 'hooks', 'orca.json')
    mkdirSync(join(copilotHome, 'hooks'), { recursive: true })
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          version: 1,
          hooks: {
            UserPromptSubmit: [
              { type: 'command', bash: 'echo user prompt' },
              makeStaleManagedHookDefinition()
            ],
            OldEvent: [makeStaleManagedHookDefinition()]
          }
        },
        null,
        2
      )
    )

    const service = new CopilotHookService()
    service.install()
    const hooks = readConfig().hooks as Record<string, unknown[]>

    expect(hooks.OldEvent).toBeUndefined()
    expect(hooks.UserPromptSubmit).toEqual(
      expect.arrayContaining([expect.objectContaining({ bash: 'echo user prompt' })])
    )
    expect(hooks.UserPromptSubmit).toHaveLength(2)
  })

  it('remove deletes only Orca-managed Copilot hooks', () => {
    const service = new CopilotHookService()
    service.install()
    const configPath = join(copilotHome, 'hooks', 'orca.json')
    const config = readConfig()
    const hooks = config.hooks as Record<string, unknown[]>
    hooks.UserPromptSubmit.unshift({ type: 'command', bash: 'echo user prompt' })
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)

    const status = service.remove()
    const nextHooks = readConfig().hooks as Record<string, unknown[]>

    expect(status.state).toBe('not_installed')
    expect(nextHooks.UserPromptSubmit).toEqual([{ type: 'command', bash: 'echo user prompt' }])
    expect(nextHooks.SessionStart).toBeUndefined()
  })

  it('remove leaves nested user hooks untouched when no managed hook is present', () => {
    const configPath = join(copilotHome, 'hooks', 'orca.json')
    mkdirSync(join(copilotHome, 'hooks'), { recursive: true })
    const original = JSON.stringify(
      {
        version: 1,
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                { type: 'command', command: 'echo nested user hook' },
                { type: 'command', command: 'echo another user hook' }
              ]
            }
          ]
        }
      },
      null,
      2
    )
    writeFileSync(configPath, original)

    const status = new CopilotHookService().remove()

    expect(status.state).toBe('not_installed')
    expect(readFileSync(configPath, 'utf-8')).toBe(original)
  })
})
