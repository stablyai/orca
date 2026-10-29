import { describe, expect, it, vi } from 'vitest'
import { revealCreatedTerminal } from './terminal-create-reveal'

const launchConfig = { agentArgs: '--dangerously-skip-permissions', agentEnv: {} }
const recipe = {
  tabId: 'tab',
  leafId: 'leaf',
  launchConfig,
  launchToken: 'token',
  launchAgent: 'claude'
}

async function reveal(args: {
  presentation: 'background' | 'focused'
  revealFails?: boolean
  adoptedStablePane?: boolean
}) {
  const notifier = {
    revealTerminalSession: vi.fn(async () => {
      if (args.revealFails) {
        throw new Error('Terminal reveal timed out')
      }
      return { tabId: 'tab' }
    }),
    rememberLaunchRecipe: vi.fn()
  }
  const result = await revealCreatedTerminal({
    notifier,
    workspace: { id: 'wt', path: '/repo' },
    ptyId: 'pty',
    handle: 'term_1',
    cwd: '/repo',
    launchOpts: { launchAgent: 'claude' },
    effectiveLaunchConfig: launchConfig,
    launchToken: 'token',
    adoptedStablePane: args.adoptedStablePane ?? false,
    presentation: args.presentation,
    opts: {},
    tabId: 'tab',
    leafId: 'leaf'
  })
  return { notifier, surface: result.surface }
}

describe('revealCreatedTerminal launch recipe', () => {
  it.each([
    { name: 'a background launch', presentation: 'background' as const },
    { name: 'a launch whose reveal failed', presentation: 'focused' as const, revealFails: true }
  ])('tells the window the recipe of $name', async (args) => {
    const { notifier, surface } = await reveal(args)

    expect(surface).toBe('background')
    expect(notifier.rememberLaunchRecipe).toHaveBeenCalledWith(recipe)
  })

  it('never re-registers an adopted pane, whose launch token is already spent', async () => {
    const { notifier } = await reveal({ presentation: 'background', adoptedStablePane: true })

    expect(notifier.rememberLaunchRecipe).not.toHaveBeenCalled()
  })
})
