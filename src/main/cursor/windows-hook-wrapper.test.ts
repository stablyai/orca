import { describe, expect, it } from 'vitest'
import { createManagedCommandMatcher } from '../agent-hooks/installation/commands/managed-hook-command-matching'
import { wrapWindowsBatchHookCommand } from '../agent-hooks/installation/commands/windows-direct-cmd-hook-command'
import { parseHookEnvelope } from '../../shared/agent-hook-listener/hook-envelope'
import { createHookListenerState } from '../../shared/agent-hook-listener/listener-state'
import { makePaneKey } from '../../shared/workspace-layout/stable-pane-id'
import { CURSOR_EVENTS } from './hook-events'
import { getWindowsCursorWrapperScript, getWindowsManagedScript } from './hook-script'

// The wrapper is what Windows Cursor actually runs, so its text is the contract under test.
function lines(script: string): string[] {
  return script.split('\r\n')
}

// Windows hands the hook a drive-letter path; process.platform during a test run does not.
const WRAPPER_PATH = (event: string): string =>
  `C:\\Users\\dev\\.orca\\agent-hooks\\cursor-${event}.cmd`

describe('Cursor Windows hook wrapper', () => {
  it('names the event and answer for every registered event', () => {
    for (const event of CURSOR_EVENTS) {
      const script = getWindowsCursorWrapperScript(event)
      expect(script).toContain('setlocal DisableDelayedExpansion')
      expect(script).toContain(`set "ORCA_CURSOR_HOOK_EVENT=${event}"`)
      expect(script).toContain('set "ORCA_CURSOR_HOOK_CORE=%~dp0cursor-hook.cmd"')
      // The core answers the agent; the wrapper only answers when the core is missing.
      expect(lines(script)).toContain('  call "%ORCA_CURSOR_HOOK_CORE%"')
    }
  })

  it('skips the reply and the post outside an Orca pane', () => {
    const script = lines(getWindowsCursorWrapperScript('stop'))
    const guards = script.filter((line) => line.startsWith('if "%ORCA_'))
    expect(guards.length).toBeGreaterThan(0)
    // Every guard exits before the core runs, so a stale hooks.json never leaks a reply or a POST.
    for (const guard of guards) {
      expect(guard.endsWith('exit /b 0')).toBe(true)
    }
  })

  it('keeps the beforeSubmitPrompt answer Cursor expects', () => {
    expect(getWindowsCursorWrapperScript('beforeSubmitPrompt')).toContain(
      'set "ORCA_CURSOR_HOOK_RESPONSE={"continue":true}"'
    )
    expect(getWindowsCursorWrapperScript('stop')).toContain('set "ORCA_CURSOR_HOOK_RESPONSE={}"')
  })

  it('registers the wrapper bare, not through a PowerShell launcher', () => {
    for (const event of CURSOR_EVENTS) {
      const command = wrapWindowsBatchHookCommand(WRAPPER_PATH(event))
      // A CMD-safe path under Orca's data dir needs no interpreter in between.
      expect(command.includes('powershell')).toBe(false)
      expect(command.replaceAll('\\', '/')).toContain(`agent-hooks/cursor-${event}.cmd`)
    }
  })

  it('is owned by the build that wrote it, and by nothing else', () => {
    const matchers = CURSOR_EVENTS.map((event) =>
      createManagedCommandMatcher(`cursor-${event}.cmd`)
    )
    for (const event of CURSOR_EVENTS) {
      const command = wrapWindowsBatchHookCommand(WRAPPER_PATH(event))
      expect(matchers.some((matcher) => matcher(command))).toBe(true)
    }
    // A user's own hook that happens to sit beside Orca's is left alone.
    expect(matchers.some((matcher) => matcher('C:/Users/dev/tools/my-hook.cmd'))).toBe(false)
  })

  it('posts the event the wrapper named, so Cursor status keeps working', () => {
    const script = getWindowsManagedScript()
    // The form line precedes payload@- and keeps cmd's continuation caret.
    const eventAt = script.indexOf('hookEventName=%ORCA_CURSOR_HOOK_EVENT%')
    expect(eventAt).toBeGreaterThan(-1)
    expect(eventAt).toBeLessThan(script.indexOf('payload@-'))
  })
})

describe('Cursor hook event on the wire', () => {
  it('takes the event from the wrapper instead of the payload', () => {
    const paneKey = makePaneKey('tab-1', 'b7e7a0f6-4d2f-4b8d-9f6f-1f2a3c4d5e6f')
    const envelope = parseHookEnvelope(
      createHookListenerState(),
      'cursor',
      {
        paneKey,
        hookEventName: 'postToolUse',
        payload: { tool_name: 'Read' }
      },
      ''
    )
    expect(envelope?.eventName).toBe('postToolUse')
  })

  it('still accepts Cursor payloads that name no event', () => {
    const paneKey = makePaneKey('tab-1', 'b7e7a0f6-4d2f-4b8d-9f6f-1f2a3c4d5e6f')
    const envelope = parseHookEnvelope(
      createHookListenerState(),
      'cursor',
      { paneKey, payload: { tool_name: 'Read' } },
      ''
    )
    expect(envelope?.eventName).toBeUndefined()
  })
})
