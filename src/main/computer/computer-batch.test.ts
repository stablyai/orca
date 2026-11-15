import { describe, expect, it, vi } from 'vitest'
import type {
  ComputerActionResult,
  ComputerActionVerification,
  ComputerSnapshotResult
} from '../../shared/computer-use-runtime-types'
import { runComputerBatch, type ComputerBatchDeps } from './computer-batch'
import { RuntimeClientError } from './runtime-client-error'

function state(treeText: string): ComputerSnapshotResult {
  return {
    snapshot: {
      id: 'snap',
      app: { name: 'Calculator', bundleId: 'com.apple.calculator', pid: 42 },
      window: { id: 7, index: 0, title: 'Calculator', width: 200, height: 300 },
      coordinateSpace: 'window',
      treeText,
      elementCount: 1,
      focusedElementId: null
    },
    screenshot: null,
    screenshotStatus: { state: 'skipped', reason: 'no_screenshot_flag' }
  }
}

function acted(verification: ComputerActionVerification): ComputerActionResult {
  return { ...state('0 window Calculator'), action: { path: 'synthetic', verification } }
}

const SYNTHETIC = { state: 'unverified', reason: 'synthetic_input' } as const
const NOOP = { state: 'unverified', reason: 'suspected_noop' } as const

function deps(actions: (ComputerActionResult | Error)[]): ComputerBatchDeps & {
  runAction: ReturnType<typeof vi.fn>
  getAppState: ReturnType<typeof vi.fn>
} {
  const runAction = vi.fn()
  for (const result of actions) {
    if (result instanceof Error) {
      runAction.mockRejectedValueOnce(result)
    } else {
      runAction.mockResolvedValueOnce(result)
    }
  }
  return {
    runAction,
    getAppState: vi.fn().mockResolvedValue(state('0 window Calculator\n\t1 text 56')),
    sleep: vi.fn().mockResolvedValue(undefined)
  }
}

describe('runComputerBatch', () => {
  it('runs each step on the batch target and reads the window once afterwards', async () => {
    const d = deps([acted({ state: 'verified', property: 'value' }), acted(SYNTHETIC)])

    const result = await runComputerBatch(
      {
        app: 'Calculator',
        session: 's1',
        windowId: 7,
        treeDiff: true,
        noScreenshot: true,
        steps: [
          { command: 'set-value', 'element-index': 4, value: '7' },
          { command: 'wait', ms: 200 },
          { command: 'press-key', key: 'Return' }
        ]
      },
      d
    )

    expect(d.runAction.mock.calls).toEqual([
      [
        'setValue',
        expect.objectContaining({
          app: 'Calculator',
          session: 's1',
          windowId: 7,
          elementIndex: 4,
          value: '7',
          noScreenshot: true,
          keepTreeBaseline: true
        })
      ],
      [
        'pressKey',
        expect.objectContaining({ key: 'Return', noScreenshot: true, keepTreeBaseline: true })
      ]
    ])
    expect(d.sleep).toHaveBeenCalledWith(200)
    expect(d.getAppState).toHaveBeenCalledTimes(1)
    expect(d.getAppState).toHaveBeenCalledWith({
      app: 'Calculator',
      session: 's1',
      windowId: 7,
      noScreenshot: true,
      treeDiff: true
    })
    expect(result.snapshot?.treeText).toBe('0 window Calculator\n\t1 text 56')
    expect(result.batch).toMatchObject({ total: 3, completed: 3, stopOn: 'suspect' })
    expect(result.batch.stoppedAt).toBeUndefined()
    expect(result.steps.map((step) => [step.command, step.ok])).toEqual([
      ['set-value', true],
      ['wait', true],
      ['press-key', true]
    ])
  })

  it('checks every step before running the first one', async () => {
    const d = deps([])

    await expect(
      runComputerBatch(
        {
          app: 'Calculator',
          steps: [
            { command: 'press-key', key: 'Return' },
            { command: 'click', elementIndex: 3, windowId: 9 }
          ]
        },
        d
      )
    ).rejects.toThrow('Batch step 2: windowId applies to the whole batch')
    await expect(
      runComputerBatch({ app: 'Calculator', steps: [{ command: 'click', element_index: 3 }] }, d)
    ).rejects.toThrow('Batch step 1: click has no field "element_index"')
    await expect(
      runComputerBatch(
        {
          app: 'Calculator',
          steps: [{ command: 'hotkey', key: 'CmdOrCtrl+A' }, { command: 'click' }]
        },
        d
      )
    ).rejects.toThrow('Batch step 2: click: Click requires --element-index or both --x and --y')
    expect(d.runAction).not.toHaveBeenCalled()
  })

  it('stops at a suspected noop by default but runs past synthetic input', async () => {
    const d = deps([acted(SYNTHETIC), acted(NOOP)])

    const result = await runComputerBatch(
      {
        app: 'Calculator',
        steps: [
          { command: 'press-key', key: 'Escape' },
          { command: 'click', elementIndex: 3 },
          { command: 'click', elementIndex: 4 }
        ]
      },
      d
    )

    expect(d.runAction).toHaveBeenCalledTimes(2)
    expect(result.batch).toMatchObject({ completed: 2, stoppedAt: 2, stopReason: 'suspect' })
    expect(result.steps.at(-1)?.verification).toEqual(NOOP)
    expect(d.getAppState).toHaveBeenCalledTimes(1)
  })

  it('stops at synthetic input with --stop-on unverified, and never with --stop-on error', async () => {
    const strict = deps([acted(SYNTHETIC)])
    const strictResult = await runComputerBatch(
      {
        app: 'Calculator',
        stopOn: 'unverified',
        steps: [
          { command: 'press-key', key: 'Escape' },
          { command: 'press-key', key: 'Return' }
        ]
      },
      strict
    )
    expect(strict.runAction).toHaveBeenCalledTimes(1)
    expect(strictResult.batch).toMatchObject({ stoppedAt: 1, stopReason: 'unverified' })

    const lenient = deps([acted(NOOP), acted(NOOP)])
    const lenientResult = await runComputerBatch(
      {
        app: 'Calculator',
        stopOn: 'error',
        steps: [
          { command: 'click', elementIndex: 3 },
          { command: 'click', elementIndex: 4 }
        ]
      },
      lenient
    )
    expect(lenient.runAction).toHaveBeenCalledTimes(2)
    expect(lenientResult.batch.stoppedAt).toBeUndefined()
  })

  it('reports the failing step and still returns the state after it', async () => {
    const d = deps([
      acted(SYNTHETIC),
      new RuntimeClientError('element_not_found', 'element 9 is stale')
    ])

    const result = await runComputerBatch(
      {
        app: 'Calculator',
        steps: [
          { command: 'press-key', key: 'Escape' },
          { command: 'set-value', elementIndex: 9, value: 'x' },
          { command: 'press-key', key: 'Return' }
        ]
      },
      d
    )

    expect(d.runAction).toHaveBeenCalledTimes(2)
    expect(result.batch).toMatchObject({
      total: 3,
      completed: 1,
      stoppedAt: 2,
      stopReason: 'error'
    })
    expect(result.steps[1]).toMatchObject({
      ok: false,
      error: { code: 'element_not_found', message: 'element 9 is stale' }
    })
    expect(result.snapshot?.treeText).toBe('0 window Calculator\n\t1 text 56')
  })
})
