import { describe, expect, it, vi } from 'vitest'
import { longPressHostedIosAccessibilityControlByLabelPrefix } from '../../scripts/hosted-ios-emulator-long-press.mjs'

const emulator = {
  deviceUdid: 'simulator-a',
  orcaCli: '/repo/config/scripts/orca-dev.mjs',
  userDataDir: '/tmp/orca-mobile/userData',
  worktree: '/repo'
}

const rowTree = {
  ok: true,
  result: [
    {
      label: 'mobile-rearch, mobile-rearch, 1',
      enabled: true,
      frame: { x: 0, y: 0.2, width: 1, height: 0.1 }
    }
  ]
}

const sheetTree = {
  ok: true,
  result: [
    { label: 'Source Control', enabled: true, frame: { x: 0, y: 0.7, width: 1, height: 0.05 } }
  ]
}

function axResponse(tree: unknown) {
  return { stderr: '', stdout: JSON.stringify(tree) }
}

function gesturePoints(call: [unknown, string[]] | undefined) {
  return JSON.parse(call?.[1][1] as string)
}

describe('hosted iOS emulator long press', () => {
  it('holds the touch down across two gesture commands', async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce(axResponse(rowTree))
      .mockResolvedValueOnce({ stderr: '', stdout: JSON.stringify({ ok: true }) })
      .mockResolvedValueOnce(axResponse(sheetTree))
      .mockResolvedValueOnce({ stderr: '', stdout: JSON.stringify({ ok: true }) })

    await expect(
      longPressHostedIosAccessibilityControlByLabelPrefix(
        emulator,
        'mobile-rearch',
        20_000,
        runCommand,
        'Source Control'
      )
    ).resolves.toEqual({ x: 0.5, y: 0.25 })

    // Why: a single command batches its points, so the press must span two commands.
    expect(runCommand.mock.calls[1]?.[1][0]).toBe('gesture')
    expect(gesturePoints(runCommand.mock.calls[1])).toEqual([
      { type: 'begin', x: 0.5, y: 0.25 },
      { type: 'move', x: 0.5, y: 0.25 }
    ])
    expect(runCommand.mock.calls[3]?.[1][0]).toBe('gesture')
    expect(gesturePoints(runCommand.mock.calls[3])).toEqual([
      { type: 'move', x: 0.5, y: 0.25 },
      { type: 'end', x: 0.5, y: 0.25 }
    ])
  })

  it('releases the touch when the press never settles', async () => {
    const runCommand = vi.fn(async (_args: unknown, command: string[]) => {
      if (command[0] === 'ax') {
        return axResponse(rowTree)
      }
      return { stderr: '', stdout: JSON.stringify({ ok: true }) }
    })

    await expect(
      longPressHostedIosAccessibilityControlByLabelPrefix(
        emulator,
        'mobile-rearch',
        2_000,
        runCommand,
        'Source Control'
      )
    ).rejects.toThrow('Source Control was not accessible')

    const endGestures = runCommand.mock.calls.filter(
      (call) => call[1][0] === 'gesture' && gesturePoints(call).at(-1).type === 'end'
    )
    expect(endGestures).toHaveLength(1)
  })
})
