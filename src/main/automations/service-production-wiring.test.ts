import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('automation production agent-launch gate wiring', () => {
  const source = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')

  it('classifies the resolved agent before desktop and headless dispatch', () => {
    const serviceStart = source.indexOf('automations = new AutomationService(store, {')
    const dispatcherStart = source.indexOf('headlessDispatcher:', serviceStart)
    const classifierStart = source.indexOf('classifyAgentLaunch:', serviceStart)

    expect(serviceStart).toBeGreaterThanOrEqual(0)
    expect(classifierStart).toBeGreaterThan(serviceStart)
    expect(classifierStart).toBeLessThan(dispatcherStart)
    expect(source.slice(classifierStart, dispatcherStart)).toContain(
      'runtimeService.classifyAgentLaunchForAutomation('
    )
    expect(source.slice(classifierStart, dispatcherStart)).toContain('target.cwd')
  })

  it('launches headless agents through launchAgentTerminal, never the built-in-only startup arm', () => {
    const dispatcherStart = source.indexOf('headlessDispatcher:')
    const dispatcherEnd = source.indexOf(': undefined', dispatcherStart)

    expect(dispatcherStart).toBeGreaterThanOrEqual(0)
    const dispatcher = source.slice(dispatcherStart, dispatcherEnd)
    // Both workspace modes resolve the agent (custom ids included) through the
    // launch-time path; the create-time legacy startup arm is built-in-only and
    // resolves before the worktree path exists.
    expect(dispatcher).toContain('runtimeService.launchAgentTerminal(')
    expect(dispatcher).not.toContain('startupAgent')
    expect(dispatcher).not.toContain('startupTerminal')
  })
})
