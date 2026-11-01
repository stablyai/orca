import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { readHooksJson, wrapWindowsHookCommand } from '../agent-hooks/installer-utils'
import { createAgentHookMemorySftp } from '../agent-hooks/agent-hook-memory-sftp.test-fixture'
import { COPILOT_EVENTS, getManagedCommand } from './copilot-managed-hook-definitions'
import { getManagedScript } from './copilot-managed-script'
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
      const scriptPath = join(tmpDir, '.orca', 'agent-hooks', 'copilot-hook.cmd')
      expect(firstPromptHook.powershell).toBe(getManagedCommand(scriptPath, 'UserPromptSubmit'))
    } else {
      expect(firstPromptHook.bash).toContain('if [ -f ')
      expect(firstPromptHook.bash).toContain('] && [ -x ')
      expect(firstPromptHook.bash).toContain('.orca/agent-hooks/copilot-hook.sh')
      expect(firstPromptHook.bash).toContain("ORCA_COPILOT_HOOK_EVENT='UserPromptSubmit'")
    }
    expect(existsSync(join(tmpDir, '.orca', 'agent-hooks', 'copilot-hook.sh'))).toBe(
      process.platform !== 'win32'
    )
    expect(existsSync(join(tmpDir, '.orca', 'agent-hooks', 'copilot-hook.cmd'))).toBe(
      process.platform === 'win32'
    )
  })

  describe('on Windows', () => {
    beforeEach(() => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    })

    it('runs the .cmd through cmd.exe /d with the event as its argument', () => {
      vi.stubEnv('SystemRoot', 'C:\\Windows')
      for (const eventName of COPILOT_EVENTS) {
        expect(
          getManagedCommand('C:\\Users\\alice\\.orca\\agent-hooks\\copilot-hook.cmd', eventName)
        ).toBe(
          `C:/Windows/System32/cmd.exe /d /c C:/Users/alice/.orca/agent-hooks/copilot-hook.cmd ${eventName}`
        )
      }
      vi.unstubAllEnvs()
    })

    it('passes the event through the encoded launcher when the path is not cmd-safe', () => {
      const scriptPath = 'C:\\Users\\Bob Smith\\.orca\\agent-hooks\\copilot-hook.cmd'
      for (const eventName of COPILOT_EVENTS) {
        expect(getManagedCommand(scriptPath, eventName)).toBe(
          wrapWindowsHookCommand(scriptPath, { ORCA_COPILOT_HOOK_EVENT: eventName })
        )
      }
    })

    it('writes a cmd script that answers first and posts the event name with curl', () => {
      const script = getManagedScript()
      const lines = script.split('\r\n')
      expect(lines.slice(0, 3)).toEqual(['@echo off', 'setlocal', 'echo {}'])
      expect(script).toContain('if not "%~1"=="" set "ORCA_COPILOT_HOOK_EVENT=%~1"')
      expect(script).toContain('"%SystemRoot%\\System32\\curl.exe" -sS -X POST')
      expect(script).toContain('/hook/copilot')
      expect(script).toContain('--data-urlencode "hookEventName=%ORCA_COPILOT_HOOK_EVENT%" ^')
      expect(script).not.toMatch(/powershell|Invoke-WebRequest/i)
      // #11549: the env guard must run before curl owns stdin.
      expect(script.indexOf('if "%ORCA_PANE_KEY%"=="" exit /b 0')).toBeLessThan(
        script.indexOf('payload@-')
      )
      expect(script.indexOf('set "ORCA_COPILOT_HOOK_EVENT')).toBeLessThan(
        script.indexOf('hookEventName=')
      )
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

    it('keeps installing the POSIX script on SSH hosts', async () => {
      const remote = createAgentHookMemorySftp()
      const status = await new CopilotHookService().installRemote(remote.sftp, '/home/alice')
      expect(status.state).toBe('installed')
      const installed = remote.fs.files.get('/home/alice/.copilot/hooks/orca.json')
      expect(installed).toContain('/home/alice/.orca/agent-hooks/copilot-hook.sh')
      expect(installed).not.toMatch(/powershell|EncodedCommand|copilot-hook\.cmd/)
      expect(remote.fs.files.get('/home/alice/.orca/agent-hooks/copilot-hook.sh')).toContain(
        '#!/bin/sh'
      )
    })
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
