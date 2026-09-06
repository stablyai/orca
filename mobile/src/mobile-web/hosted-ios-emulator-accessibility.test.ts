import { describe, expect, it, vi } from 'vitest'
import {
  rotateHostedIosEmulator,
  tapHostedIosAccessibilityControl,
  tapHostedIosAccessibilityControlAtOccurrence,
  tapHostedIosAccessibilityControlAtLastOccurrence,
  tapHostedIosAccessibilityControlByLabelPrefix,
  tapHostedIosAccessibilityControlByLabelPrefixAtPosition,
  tapHostedIosAccessibilityControlStartingWith,
  tapHostedIosPoint,
  typeHostedIosText,
  waitForHostedIosAccessibilityControl,
  waitForHostedIosAccessibilityControlByLabelPrefix,
  waitForHostedIosAccessibilityControlEndingWith,
  waitForHostedIosAccessibilityControlMatching,
  waitForHostedIosAccessibilityLabel,
  waitForHostedIosAccessibilityLabelToDisappear
} from '../../scripts/hosted-ios-emulator-accessibility.mjs'

const emulator = {
  deviceUdid: 'simulator-a',
  orcaCli: '/repo/config/scripts/orca-dev.mjs',
  userDataDir: '/tmp/orca-mobile/userData',
  worktree: '/repo'
}

describe('hosted iOS emulator accessibility controls', () => {
  it('rotates through the isolated Orca emulator controller', async () => {
    const runCommand = vi.fn().mockResolvedValue({ stderr: '', stdout: '{}' })

    await rotateHostedIosEmulator(emulator, 'landscape_left', runCommand)

    expect(runCommand).toHaveBeenCalledWith(emulator, ['rotate', 'landscape_left'])
  })

  it('finds a nested enabled control and taps its normalized center', async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce({
        stderr: '',
        stdout: JSON.stringify({
          ok: true,
          result: [
            {
              label: 'Orca',
              children: [
                {
                  label: 'Resume agent session',
                  enabled: true,
                  frame: { x: 0.6, y: 0.7, width: 0.2, height: 0.1 }
                }
              ]
            }
          ]
        })
      })
      .mockResolvedValueOnce({ stderr: '', stdout: JSON.stringify({ ok: true }) })

    await expect(
      tapHostedIosAccessibilityControl(emulator, 'Resume agent session', 1_000, runCommand)
    ).resolves.toEqual({ x: 0.7, y: 0.75 })
    expect(runCommand).toHaveBeenLastCalledWith(emulator, ['tap', '0.7', '0.75'])
  })

  it('selects a specific visible occurrence without changing the label contract', async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce({
        stderr: '',
        stdout: JSON.stringify({
          ok: true,
          result: [
            {
              label: 'mobile-rearch',
              enabled: true,
              frame: { x: 0.1, y: 0.1, width: 0.3, height: 0.1 }
            },
            {
              label: 'mobile-rearch',
              enabled: true,
              frame: { x: 0.1, y: 0.3, width: 0.3, height: 0.1 }
            }
          ]
        })
      })
      .mockResolvedValueOnce({ stderr: '', stdout: JSON.stringify({ ok: true }) })

    await expect(
      tapHostedIosAccessibilityControlAtOccurrence(emulator, 'mobile-rearch', 1, 1_000, runCommand)
    ).resolves.toEqual({ x: 0.25, y: 0.35 })
    expect(runCommand).toHaveBeenLastCalledWith(emulator, ['tap', '0.25', '0.35'])
  })

  it('targets the last visible occurrence for native photo grids', async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce({
        stderr: '',
        stdout: JSON.stringify({
          ok: true,
          result: [
            {
              label: 'Photo',
              enabled: true,
              frame: { x: 0, y: 0.2, width: 0.3, height: 0.1 }
            },
            {
              label: 'Photo',
              enabled: true,
              frame: { x: 0.3, y: 0.4, width: 0.3, height: 0.1 }
            }
          ]
        })
      })
      .mockResolvedValueOnce({ stderr: '', stdout: JSON.stringify({ ok: true }) })

    await expect(
      tapHostedIosAccessibilityControlAtLastOccurrence(emulator, 'Photo', 1_000, runCommand)
    ).resolves.toEqual({ x: 0.44999999999999996, y: 0.45 })
    expect(runCommand).toHaveBeenLastCalledWith(emulator, ['tap', '0.44999999999999996', '0.45'])
  })

  it('targets a composite native row by its leading visible label', async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce({
        stderr: '',
        stdout: JSON.stringify({
          ok: true,
          result: [
            {
              label: 'mobile-rearch, mobile-rearch, 1',
              enabled: true,
              frame: { x: 0, y: 0.2, width: 1, height: 0.1 }
            }
          ]
        })
      })
      .mockResolvedValueOnce({ stderr: '', stdout: JSON.stringify({ ok: true }) })

    await expect(
      tapHostedIosAccessibilityControlByLabelPrefix(emulator, 'mobile-rearch', 1_000, runCommand)
    ).resolves.toEqual({ x: 0.5, y: 0.25 })
    expect(runCommand).toHaveBeenLastCalledWith(emulator, ['tap', '0.5', '0.25'])
  })

  it('taps a relative position within a composite native control', async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce({
        stderr: '',
        stdout: JSON.stringify({
          ok: true,
          result: [
            {
              label: 'orca-document-upload-fixture, Image',
              enabled: true,
              frame: { x: 0.1, y: 0.2, width: 0.2, height: 0.4 }
            }
          ]
        })
      })
      .mockResolvedValueOnce({ stderr: '', stdout: JSON.stringify({ ok: true }) })

    await expect(
      tapHostedIosAccessibilityControlByLabelPrefixAtPosition(
        emulator,
        'orca-document-upload-fixture',
        { x: 0.5, y: 0.25 },
        1_000,
        runCommand
      )
    ).resolves.toEqual({ x: 0.2, y: 0.30000000000000004 })
    expect(runCommand).toHaveBeenLastCalledWith(emulator, ['tap', '0.2', '0.30000000000000004'])
  })

  it('targets a dynamic control whose label starts with a stable action prefix', async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce({
        stderr: '',
        stdout: JSON.stringify({
          ok: true,
          result: [
            {
              label: 'Open changed file mobile/app/index.tsx',
              enabled: true,
              frame: { x: 0.1, y: 0.3, width: 0.8, height: 0.1 }
            }
          ]
        })
      })
      .mockResolvedValueOnce({ stderr: '', stdout: JSON.stringify({ ok: true }) })

    await expect(
      tapHostedIosAccessibilityControlStartingWith(
        emulator,
        'Open changed file ',
        1_000,
        runCommand
      )
    ).resolves.toEqual({ x: 0.5, y: 0.35 })
    expect(runCommand).toHaveBeenLastCalledWith(emulator, ['tap', '0.5', '0.35'])
  })

  it('reads a composite native row point without tapping it', async () => {
    const runCommand = vi.fn().mockResolvedValueOnce({
      stderr: '',
      stdout: JSON.stringify({
        ok: true,
        result: [
          {
            label: 'Hybrid Agent History Fixture, 2h, Preview',
            enabled: true,
            frame: { x: 0.1, y: 0.2, width: 0.8, height: 0.1 }
          }
        ]
      })
    })

    await expect(
      waitForHostedIosAccessibilityControlByLabelPrefix(
        emulator,
        'Hybrid Agent History Fixture',
        1_000,
        runCommand
      )
    ).resolves.toEqual({ x: 0.5, y: 0.25 })
    expect(runCommand).toHaveBeenCalledTimes(1)
  })

  it('waits for a dynamic count by its stable suffix', async () => {
    const runCommand = vi.fn().mockResolvedValueOnce({
      stderr: '',
      stdout: JSON.stringify({
        ok: true,
        result: [
          {
            label: '128 on branch',
            enabled: true,
            frame: { x: 0.6, y: 0.3, width: 0.3, height: 0.1 }
          }
        ]
      })
    })

    await expect(
      waitForHostedIosAccessibilityControlEndingWith(emulator, ' on branch', 1_000, runCommand)
    ).resolves.toEqual({ x: 0.75, y: 0.35 })
  })

  it('returns metadata for a visible control matched by shape', async () => {
    const runCommand = vi.fn().mockResolvedValueOnce({
      stderr: '',
      stdout: JSON.stringify({
        ok: true,
        result: [
          {
            label: 'Stable task title, 3m, Issue · orca #1, Open',
            value: '',
            enabled: true,
            frame: { x: 0.1, y: 0.3, width: 0.8, height: 0.1 }
          }
        ]
      })
    })

    await expect(
      waitForHostedIosAccessibilityControlMatching(
        emulator,
        (node) => node.label?.endsWith(', Open'),
        1_000,
        runCommand
      )
    ).resolves.toEqual({
      label: 'Stable task title, 3m, Issue · orca #1, Open',
      value: '',
      x: 0.5,
      y: 0.35
    })
  })

  it('accepts a tall visible label whose center is below the viewport', async () => {
    const runCommand = vi.fn().mockResolvedValueOnce({
      stderr: '',
      stdout: JSON.stringify({
        ok: true,
        result: [
          {
            label: 'File preview',
            value: '',
            enabled: true,
            frame: { x: 0.03, y: 0.28, width: 0.94, height: 1.52 }
          }
        ]
      })
    })

    await expect(
      waitForHostedIosAccessibilityLabel(emulator, 'File preview', 1_000, runCommand)
    ).resolves.toEqual({
      frame: { x: 0.03, y: 0.28, width: 0.94, height: 1.52 },
      label: 'File preview',
      value: ''
    })
  })

  it('rejects an invalid accessibility response', async () => {
    await expect(
      waitForHostedIosAccessibilityControl(emulator, 'Resume agent session', 1_000, async () => ({
        stderr: '',
        stdout: JSON.stringify({ ok: true, result: null })
      }))
    ).rejects.toThrow('invalid accessibility response')
  })

  it('restarts a wedged emulator controller before retrying accessibility', async () => {
    const runCommand = vi.fn(async (_args, command) => {
      if (command[0] === 'ax' && runCommand.mock.calls.length === 1) {
        throw new Error('emulator_helper_failed: request timed out')
      }
      if (command[0] === 'ax') {
        return {
          stderr: '',
          stdout: JSON.stringify({
            ok: true,
            result: [
              {
                label: 'Resume agent session',
                enabled: true,
                frame: { x: 0.6, y: 0.7, width: 0.2, height: 0.1 }
              }
            ]
          })
        }
      }
      return { stderr: '', stdout: JSON.stringify({ ok: true }) }
    })

    await expect(
      waitForHostedIosAccessibilityControl(emulator, 'Resume agent session', 1_000, runCommand)
    ).resolves.toEqual({ x: 0.7, y: 0.75 })
    expect(runCommand.mock.calls.map(([, command]) => command[0])).toEqual([
      'ax',
      'kill',
      'attach',
      'ax'
    ])
    expect(runCommand).toHaveBeenNthCalledWith(3, emulator, ['attach', emulator.deviceUdid])
  })

  it('reattaches an explicit device before retrying a point tap', async () => {
    const runCommand = vi
      .fn()
      .mockRejectedValueOnce(new Error('emulator_no_active'))
      .mockResolvedValue({ stderr: '', stdout: JSON.stringify({ ok: true }) })
    const point = { x: 0.25, y: 0.75 }

    await expect(tapHostedIosPoint(emulator, point, runCommand)).resolves.toEqual(point)
    expect(runCommand.mock.calls.map(([, command]) => command[0])).toEqual([
      'tap',
      'kill',
      'attach',
      'tap'
    ])
    expect(runCommand).toHaveBeenNthCalledWith(3, emulator, ['attach', emulator.deviceUdid])
  })

  it('types through the isolated emulator controller', async () => {
    const runCommand = vi.fn().mockResolvedValue({
      stderr: '',
      stdout: JSON.stringify({ ok: true })
    })

    await typeHostedIosText(emulator, 'Hybrid Agent History Fixture', runCommand)

    expect(runCommand.mock.calls.map(([, command]) => command)).toEqual(
      Array.from('Hybrid Agent History Fixture', (character) => ['type', character])
    )
  })

  it('retries transient helper failures while reattaching a point tap', async () => {
    let attachAttempts = 0
    const runCommand = vi.fn(async (_args, command) => {
      if (command[0] === 'tap' && runCommand.mock.calls.length === 1) {
        throw new Error('emulator_no_active')
      }
      if (command[0] === 'attach' && attachAttempts++ === 0) {
        throw new Error('emulator_helper_failed: stream endpoints unavailable')
      }
      return { stderr: '', stdout: JSON.stringify({ ok: true }) }
    })

    await expect(tapHostedIosPoint(emulator, { x: 0.25, y: 0.75 }, runCommand)).resolves.toEqual({
      x: 0.25,
      y: 0.75
    })
    expect(runCommand.mock.calls.map(([, command]) => command[0])).toEqual([
      'tap',
      'kill',
      'attach',
      'attach',
      'tap'
    ])
  })

  it('waits for a reconnect label to leave the native accessibility tree', async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce({
        stderr: '',
        stdout: JSON.stringify({ ok: true, result: [{ label: 'Reconnecting' }] })
      })
      .mockResolvedValueOnce({
        stderr: '',
        stdout: JSON.stringify({ ok: true, result: [{ label: '1 tab' }] })
      })

    await expect(
      waitForHostedIosAccessibilityLabelToDisappear(emulator, 'Reconnecting', 1_000, runCommand)
    ).resolves.toBeUndefined()
  })
})
