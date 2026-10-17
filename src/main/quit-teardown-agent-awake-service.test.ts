import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * `before-quit` fires on attempted quits, not committed ones — a renderer beforeunload can
 * still veto it. Disposing the agent-awake service there killed the macOS `caffeinate`
 * assertion for the rest of the session on a vetoed quit, with no reconstruction path
 * (main-process-observers.ts only constructs it once, at app-ready). Follows the same
 * committed-quit precedent already used for the Windows tray icon.
 */
const source = readFileSync(join(__dirname, 'startup', 'main-process-quit.ts'), 'utf8')

function handlerBody(eventName: string, nextEventName: string): string {
  const start = source.indexOf(`app.on('${eventName}'`)
  const end = source.indexOf(`app.on('${nextEventName}'`, start)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('quit teardown of the agent-awake service', () => {
  it('is untouched by a vetoable before-quit', () => {
    const beforeQuit = handlerBody('before-quit', 'will-quit')
    expect(beforeQuit).not.toContain('agentAwakeService')
    expect(beforeQuit).not.toContain('unsubscribeAgentAwakeStatusChanges')
  })

  it('is disposed exactly once, after the will-quit commit gate', () => {
    const willQuit = handlerBody('will-quit', 'window-all-closed')
    const commitIndex = willQuit.indexOf('quitTeardownStartGate.tryStart(event)')
    const unsubscribeIndex = willQuit.indexOf('state.unsubscribeAgentAwakeStatusChanges?.()')
    const disposeIndex = willQuit.indexOf('state.agentAwakeService?.dispose()')

    expect(commitIndex).toBeGreaterThanOrEqual(0)
    expect(unsubscribeIndex).toBeGreaterThan(commitIndex)
    expect(disposeIndex).toBeGreaterThan(unsubscribeIndex)
    // Why: proves there's no second, earlier-returning duplicate of the teardown in this handler.
    expect(willQuit.match(/state\.agentAwakeService\?\.dispose\(\)/g)).toHaveLength(1)
  })
})
