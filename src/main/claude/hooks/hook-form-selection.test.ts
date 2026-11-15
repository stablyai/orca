// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { getManagedLifecycleHook, CLAUDE_HOOK_SETTINGS } from './hook-settings'

const scriptPath = String.raw`C:\Users\dev\.orca\agent-hooks\claude-hook.cmd`
const exePath = String.raw`C:\Users\dev\AppData\Local\Programs\Orca\resources\bin\orca-agent-hook.exe`
const exeForwardSlash = exePath.split(String.fromCharCode(92)).join('/')

describe('Claude managed hook form selection on Windows', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const restore = (): void => {
    Object.defineProperty(process, 'platform', platform)
  }
  afterEach(restore)

  it('uses the exec form for a safe exe path when the CLI accepts args', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const hook = getManagedLifecycleHook(scriptPath, CLAUDE_HOOK_SETTINGS, exePath, {
      execForm: true
    })
    expect(hook).toEqual({
      type: 'command',
      command: exePath,
      args: ['claude', scriptPath],
      timeout: 10
    })
  })

  it('keeps the string command when the CLI version is unknown', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const hook = getManagedLifecycleHook(scriptPath, CLAUDE_HOOK_SETTINGS, exePath, {
      execForm: false
    })
    expect(hook.command).toBe(`${exeForwardSlash} claude`)
    expect(hook.args).toBeUndefined()
  })

  it('falls back to the shell-free script command without a native exe', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const hook = getManagedLifecycleHook(scriptPath, CLAUDE_HOOK_SETTINGS, null, { execForm: true })
    expect(hook.command).toContain('claude-hook.cmd')
    expect(hook.args).toBeUndefined()
  })
})
