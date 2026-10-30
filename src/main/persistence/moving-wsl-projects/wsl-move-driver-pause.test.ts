import { describe, expect, it, vi } from 'vitest'
import { pauseWslMoveScope } from './wsl-move-driver-pause'
import type { WslMoveDriverDeps } from './wsl-move-driver-ports'

const scope = { workspaceIds: ['wt'], workspaceKeys: new Set(['wt']) }
const pane = { paneKey: 'tab:leaf', sessionId: 'wt@@a', wslDistro: 'Ubuntu' }

function deps(shellCwds?: WslMoveDriverDeps['shellCwds']): Parameters<typeof pauseWslMoveScope>[0] {
  return {
    gateInputs: async () => ({
      panes: [{ paneKey: pane.paneKey, foreground: 'shell-idle', scrollbackBytes: 0 }],
      runningAutomationRunIds: [],
      activeDispatchIds: []
    }),
    listPanes: () => [pane],
    quiesce: {
      sleepWorkspaces: vi.fn(async () => ({ failedWorktreeIds: [] })),
      livePtyIds: () => [],
      captureRestoreHints: vi.fn(),
      proveExited: vi.fn(),
      wait: async () => {}
    },
    ...(shellCwds ? { shellCwds } : {})
  }
}

describe('pauseWslMoveScope', () => {
  // An open pane's `cd deep/er` was lost, since bash on the bridge reports no folder.
  it('reads each live pane its shell folder before Sleep ends the shell', async () => {
    const order: string[] = []
    const d = deps(async () => {
      order.push('cwds')
      return new Map([[pane.paneKey, '/home/dev/app/deep/er']])
    })
    d.quiesce.sleepWorkspaces = async () => {
      order.push('sleep')
      return { failedWorktreeIds: [] }
    }
    const paused = await pauseWslMoveScope(d, scope)
    expect(order).toEqual(['cwds', 'sleep'])
    expect(paused).toEqual({ panes: [{ ...pane, shellCwd: '/home/dev/app/deep/er' }] })
  })

  it('still pauses when the folder read fails', async () => {
    const paused = await pauseWslMoveScope(
      deps(async () => {
        throw new Error('distro gone')
      }),
      scope
    )
    expect(paused).toEqual({ panes: [pane] })
  })

  // A workspace that failed the first Sleep of a move refused it at once.
  it('sleeps a failed workspace again before refusing', async () => {
    const d = deps()
    const asked: string[][] = []
    d.quiesce.sleepWorkspaces = async (ids) => {
      asked.push([...ids])
      return { failedWorktreeIds: asked.length === 1 ? ['wt'] : [] }
    }
    expect(await pauseWslMoveScope(d, scope)).toEqual({ panes: [pane] })
    expect(asked).toEqual([['wt'], ['wt']])
  })
})
