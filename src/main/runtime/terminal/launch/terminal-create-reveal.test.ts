import { describe, expect, it } from 'vitest'
import { revealCreatedTerminal } from './terminal-create-reveal'
import type { RuntimeTerminalPresentation } from '../../../../shared/terminal/runtime/runtime-terminal-contracts'

function revealWithoutWindow(presentation: RuntimeTerminalPresentation | undefined) {
  return revealCreatedTerminal({
    notifier: null,
    workspace: { id: 'repo::/w', path: '/w' },
    ptyId: 'pty-1',
    handle: 'term_1',
    cwd: '/w',
    launchOpts: {},
    effectiveLaunchConfig: undefined,
    launchToken: undefined,
    adoptedStablePane: false,
    presentation,
    opts: {},
    tabId: 'tab-1',
    leafId: 'leaf-1'
  })
}

describe('revealCreatedTerminal without a window to reveal into', () => {
  it('warns only when the caller explicitly asked for focus', async () => {
    expect(await revealWithoutWindow(undefined)).toEqual({ surface: 'background' })
    expect(await revealWithoutWindow('background')).toEqual({ surface: 'background' })
    const focused = await revealWithoutWindow('focused')
    expect(focused.surface).toBe('background')
    expect(focused.warning).toBeDefined()
  })
})
