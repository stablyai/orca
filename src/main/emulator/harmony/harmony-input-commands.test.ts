import { describe, expect, it, vi } from 'vitest'
import {
  harmonyButton,
  harmonyExec,
  harmonyRotate,
  harmonySwipe,
  harmonyTap,
  harmonyTypeText,
  leftRotationSteps,
  orientationIndex
} from './harmony-input-commands'
import type { HarmonyCommandResult, HarmonyCommandRunner } from './harmony-command-runner'
import type { HarmonySdkPaths } from './harmony-sdk-discovery'
import type { EmulatorGesturePoint } from '../emulator-gesture-sender'

const SDK: HarmonySdkPaths = {
  sdkRoot: '/sdk',
  hdc: '/sdk/hdc',
  emulator: '/sdk/Emulator'
}

const ok: HarmonyCommandResult = { stdout: '', stderr: '', code: 0 }
const size = { width: 1000, height: 2000 }

function runner(result: HarmonyCommandResult = ok): HarmonyCommandRunner {
  return vi.fn<HarmonyCommandRunner>(async () => result)
}

describe('harmonyTap', () => {
  it('sends uinput tap at device pixels', async () => {
    const run = runner()
    await harmonyTap(run, SDK, '127.0.0.1:5555', 0.5, 0.5, size)
    expect(run).toHaveBeenCalledWith(SDK.hdc, [
      '-t',
      '127.0.0.1:5555',
      'shell',
      'uinput',
      '-T',
      '-c',
      '500',
      '1000'
    ])
  })

  it('throws through ensureHarmonyOk', async () => {
    const fail: HarmonyCommandResult = { stdout: '', stderr: 'offline', code: 1 }
    await expect(harmonyTap(runner(fail), SDK, '127.0.0.1:5555', 0.5, 0.5, size)).rejects.toThrow(
      'hdc tap failed: offline'
    )
  })
})

describe('harmonySwipe', () => {
  const points: EmulatorGesturePoint[] = [
    { type: 'begin', x: 0.5, y: 0.8 },
    { type: 'move', x: 0.5, y: 0.5 },
    { type: 'end', x: 0.5, y: 0.2 }
  ]

  it('sends uinput swipe between endpoints', async () => {
    const run = runner()
    await harmonySwipe(run, SDK, '127.0.0.1:5555', points, size)
    expect(run).toHaveBeenCalledWith(SDK.hdc, [
      '-t',
      '127.0.0.1:5555',
      'shell',
      'uinput',
      '-T',
      '-m',
      '500',
      '1600',
      '500',
      '400',
      '300'
    ])
  })

  it('no-ops for fewer than two points', async () => {
    const run = runner()
    const first = points[0]
    await harmonySwipe(run, SDK, '127.0.0.1:5555', first ? [first] : [], size)
    expect(run).not.toHaveBeenCalled()
  })
})

describe('harmonyTypeText', () => {
  it('double-quotes the text as one shell arg', async () => {
    const run = runner()
    await harmonyTypeText(run, SDK, '127.0.0.1:5555', 'hello world')
    expect(run).toHaveBeenCalledWith(SDK.hdc, [
      '-t',
      '127.0.0.1:5555',
      'shell',
      'uitest',
      'uiInput',
      'text',
      '"hello world"'
    ])
  })

  it('escapes shell metacharacters', async () => {
    const mockRun = vi.fn<HarmonyCommandRunner>(async () => ok)
    await harmonyTypeText(mockRun, SDK, '127.0.0.1:5555', 'a"b$c\\d')
    expect(mockRun.mock.calls[0]?.[1]?.at(-1)).toBe('"a\\"b\\$c\\\\d"')
  })

  it('escapes backticks and newlines to block command substitution', async () => {
    const mockRun = vi.fn<HarmonyCommandRunner>(async () => ok)
    await harmonyTypeText(mockRun, SDK, '127.0.0.1:5555', 'a`b\nc')
    expect(mockRun.mock.calls[0]?.[1]?.at(-1)).toBe('"a\\`b\\\nc"')
  })
})

describe('harmonyButton', () => {
  it('sends the keycode', async () => {
    const run = runner()
    await harmonyButton(run, SDK, '127.0.0.1:5555', 'home')
    expect(run).toHaveBeenCalledWith(SDK.hdc, [
      '-t',
      '127.0.0.1:5555',
      'shell',
      'uitest',
      'uiInput',
      'keyEvent',
      '1'
    ])
  })
})

describe('harmonyExec', () => {
  it('sends one raw shell arg and returns stdout', async () => {
    const run = vi.fn<HarmonyCommandRunner>(async () => ({
      stdout: 'bundle output',
      stderr: '',
      code: 0
    }))
    const result = await harmonyExec(run, SDK, '127.0.0.1:5555', 'bm dump -n com.acme.app')
    expect(result).toBe('bundle output')
    expect(run).toHaveBeenCalledWith(SDK.hdc, [
      '-t',
      '127.0.0.1:5555',
      'shell',
      'bm dump -n com.acme.app'
    ])
  })
})

describe('orientation', () => {
  it('maps orientations to indices', () => {
    expect(orientationIndex('portrait')).toBe(0)
    expect(orientationIndex('landscape_left')).toBe(1)
    expect(orientationIndex('portrait_upside_down')).toBe(2)
    expect(orientationIndex('landscape_right')).toBe(3)
  })

  it('computes minimal left-rotation steps', () => {
    expect(leftRotationSteps(0, 1)).toBe(1)
    expect(leftRotationSteps(0, 3)).toBe(3)
    expect(leftRotationSteps(3, 0)).toBe(1)
    expect(leftRotationSteps(2, 2)).toBe(0)
  })

  it('issues one left rotation per step', async () => {
    const run = runner()
    const next = await harmonyRotate(run, SDK, 'Mate 90 Pro', 0, 3)
    expect(next).toBe(3)
    expect(run).toHaveBeenCalledTimes(3)
    expect(run).toHaveBeenCalledWith(SDK.emulator, [
      '-instance',
      'Mate 90 Pro',
      '-rotation',
      'left'
    ])
  })
})
