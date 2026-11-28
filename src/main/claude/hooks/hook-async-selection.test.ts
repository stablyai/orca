// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import {
  CLAUDE_HOOK_ASYNC_FIRST_VERSION,
  claudeAcceptsAsyncHooks
} from '../cli-capabilities/claude-hook-event-versions'
import { getManagedEventHook } from './claude-managed-event-hook'
import { applyManagedHooks, CLAUDE_HOOK_SETTINGS } from './hook-settings'
import type { ClaudeManagedHookPlan } from './claude-managed-hook-events'

const scriptPath = String.raw`C:\Users\dev\.orca\agent-hooks\claude-hook.cmd`
const exePath = String.raw`C:\Users\dev\AppData\Local\Programs\Orca\resources\bin\orca-agent-hook.exe`

describe('Claude managed hook async gate', () => {
  it('introduces async with the schema field the CLI actually has', () => {
    expect(claudeAcceptsAsyncHooks('2.1.14')).toBe(false)
    expect(claudeAcceptsAsyncHooks(CLAUDE_HOOK_ASYNC_FIRST_VERSION)).toBe(true)
    expect(claudeAcceptsAsyncHooks('2.1.325')).toBe(true)
    expect(claudeAcceptsAsyncHooks(null)).toBe(false)
  })
})

describe('Claude managed hook async selection on Windows', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const restore = (): void => {
    Object.defineProperty(process, 'platform', platform)
  }
  afterEach(restore)

  const win = (): void => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  }

  it('marks only observational events async', () => {
    win()
    const asyncFor = (eventName: string): boolean | undefined =>
      getManagedEventHook(eventName, scriptPath, CLAUDE_HOOK_SETTINGS, exePath, {
        execForm: true,
        asyncObservational: true
      }).async
    expect(asyncFor('PostToolUse')).toBe(true)
    expect(asyncFor('PostToolUseFailure')).toBe(true)
    expect(asyncFor('PostToolBatch')).toBe(true)
    expect(asyncFor('Stop')).toBe(true)
    // Orca decides or reports through these; Claude must keep waiting on them.
    expect(asyncFor('PreToolUse')).toBeUndefined()
    expect(asyncFor('PermissionRequest')).toBeUndefined()
    expect(asyncFor('UserPromptSubmit')).toBeUndefined()
    expect(asyncFor('SessionStart')).toBeUndefined()
  })

  it('keeps every event synchronous without the CLI gate', () => {
    win()
    const hook = getManagedEventHook('PostToolUse', scriptPath, CLAUDE_HOOK_SETTINGS, exePath, {
      execForm: true
    })
    expect(hook.async).toBeUndefined()
  })
})

describe('Claude managed hook async survives user choice', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const restore = (): void => {
    Object.defineProperty(process, 'platform', platform)
  }
  afterEach(restore)

  const plan = (eventName: string): ClaudeManagedHookPlan => ({
    install: [{ eventName, definition: { matcher: '*', hooks: [] } }],
    retire: [],
    statusLine: 'leave'
  })

  it('lets an explicit user async=false override the default', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const posixHook = getManagedEventHook('PostToolUse', scriptPath, CLAUDE_HOOK_SETTINGS, null, {})
    const userConfig = {
      hooks: {
        PostToolUse: [
          {
            matcher: '*',
            hooks: [{ ...posixHook, async: false }]
          }
        ]
      }
    }
    const next = applyManagedHooks(
      userConfig,
      (eventName) =>
        getManagedEventHook(eventName, scriptPath, CLAUDE_HOOK_SETTINGS, null, {
          asyncObservational: true
        }),
      'claude-hook.cmd',
      plan('PostToolUse'),
      true
    )
    const hook = next.hooks?.PostToolUse?.[0]?.hooks?.[0]
    expect(hook?.async).toBe(false)
  })
})
