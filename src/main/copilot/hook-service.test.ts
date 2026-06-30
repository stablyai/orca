import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

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
  it('installs a user-level Copilot hook file under COPILOT_HOME', () => {
    const service = new CopilotHookService()

    const status = service.install()
    const config = readConfig()

    expect(status.state).toBe('installed')
    expect(status.configPath).toBe(join(copilotHome, 'hooks', 'orca.json'))
    expect(config.version).toBe(1)
    const hooks = config.hooks as Record<string, unknown[]>
    expect(Object.keys(hooks).sort()).toEqual(
      [
        'ErrorOccurred',
        'Notification',
        'PermissionRequest',
        'PostToolUse',
        'PostToolUseFailure',
        'PreCompact',
        'PreToolUse',
        'SessionEnd',
        'SessionStart',
        'Stop',
        'SubagentStop',
        'UserPromptSubmit',
        'subagentStart'
      ].sort()
    )
    const firstPromptHook = hooks.UserPromptSubmit[0] as Record<string, unknown>
    expect(firstPromptHook.type).toBe('command')
    expect(firstPromptHook.timeoutSec).toBe(5)
    if (process.platform === 'win32') {
      expect(firstPromptHook.powershell).toContain('agent-hooks')
      expect(firstPromptHook.powershell).toContain('copilot-hook.ps1')
      expect(firstPromptHook.powershell).toContain('ORCA_COPILOT_HOOK_EVENT')
      expect(firstPromptHook.powershell).toContain('UserPromptSubmit')
    } else {
      expect(firstPromptHook.bash).toContain('if [ -x ')
      expect(firstPromptHook.bash).toContain('.orca/agent-hooks/copilot-hook.sh')
      expect(firstPromptHook.bash).toContain("ORCA_COPILOT_HOOK_EVENT='UserPromptSubmit'")
    }
    expect(existsSync(join(tmpDir, '.orca', 'agent-hooks', 'copilot-hook.sh'))).toBe(
      process.platform !== 'win32'
    )
  })

  it.skipIf(process.platform === 'win32')('writes syntactically valid POSIX commands', () => {
    const service = new CopilotHookService()
    service.install()
    const hooks = readConfig().hooks as Record<string, unknown[]>

    for (const definitions of Object.values(hooks)) {
      for (const definition of definitions) {
        const bash = (definition as Record<string, unknown>).bash
        expect(typeof bash).toBe('string')
        const result = spawnSync('/bin/sh', ['-n', '-c', bash as string])
        expect(result.status).toBe(0)
      }
    }
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

  it('reports partial when stale managed hooks only exist under retired events', () => {
    const configPath = join(copilotHome, 'hooks', 'orca.json')
    mkdirSync(join(copilotHome, 'hooks'), { recursive: true })
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          version: 1,
          hooks: {
            OldEvent: [makeStaleManagedHookDefinition()]
          }
        },
        null,
        2
      )
    )

    const status = new CopilotHookService().getStatus()

    expect(status.state).toBe('partial')
    expect(status.managedHooksPresent).toBe(true)
    expect(status.detail).toBe('Managed Copilot hook file contains stale entries')
  })

  it('reports partial when stale managed hooks remain alongside current hooks', () => {
    const service = new CopilotHookService()
    service.install()
    const configPath = join(copilotHome, 'hooks', 'orca.json')
    const config = readConfig()
    const hooks = config.hooks as Record<string, unknown[]>
    hooks.UserPromptSubmit.push(makeStaleManagedHookDefinition())
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)

    const status = service.getStatus()

    expect(status.state).toBe('partial')
    expect(status.managedHooksPresent).toBe(true)
    expect(status.detail).toBe('Managed Copilot hook file contains stale entries')
  })

  it('forces version 1 in the dedicated Copilot hook file', () => {
    const configPath = join(copilotHome, 'hooks', 'orca.json')
    mkdirSync(join(copilotHome, 'hooks'), { recursive: true })
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 99,
        hooks: {}
      })
    )

    const status = new CopilotHookService().install()
    const config = readConfig()

    expect(status.state).toBe('installed')
    expect(config.version).toBe(1)
  })

  it('clears disableAllHooks in the dedicated Copilot hook file', () => {
    const configPath = join(copilotHome, 'hooks', 'orca.json')
    mkdirSync(join(copilotHome, 'hooks'), { recursive: true })
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        disableAllHooks: true,
        hooks: {}
      })
    )

    const status = new CopilotHookService().install()
    const config = readConfig()

    expect(status.state).toBe('installed')
    expect(config.disableAllHooks).toBeUndefined()
  })

  it('reports partial when the dedicated Copilot hook file is disabled', () => {
    const service = new CopilotHookService()
    service.install()
    const configPath = join(copilotHome, 'hooks', 'orca.json')
    const config = readConfig()
    config.disableAllHooks = true
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)

    const status = service.getStatus()

    expect(status.state).toBe('partial')
    expect(status.detail).toBe('Managed Copilot hook file is disabled')
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

  it('remove does not create an orca.json file when nothing is installed', () => {
    const status = new CopilotHookService().remove()

    expect(status.state).toBe('not_installed')
    expect(existsSync(join(copilotHome, 'hooks', 'orca.json'))).toBe(false)
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

  it('returns an error status for malformed JSON', () => {
    mkdirSync(join(copilotHome, 'hooks'), { recursive: true })
    writeFileSync(join(copilotHome, 'hooks', 'orca.json'), '{not json')

    const status = new CopilotHookService().getStatus()

    expect(status).toEqual({
      agent: 'copilot',
      state: 'error',
      configPath: join(copilotHome, 'hooks', 'orca.json'),
      managedHooksPresent: false,
      detail: 'Could not parse Copilot hooks/orca.json'
    })
  })
})
