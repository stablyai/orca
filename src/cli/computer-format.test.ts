import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComputerActionResult } from '../shared/runtime-types'
import { formatComputerAction, prepareComputerCliJsonResult } from './computer-format'
import { printResult } from './format'

describe('prepareComputerCliJsonResult', () => {
  it.each([
    'Physical size: 1440x3200\n',
    '33',
    'screenshotStatus',
    '',
    42,
    -1,
    0,
    true,
    false,
    null
  ])('preserves successful primitive JSON output for %j', (result) => {
    const response = {
      id: 'req-primitive',
      ok: true as const,
      result,
      _meta: { runtimeId: 'runtime-1' }
    }
    const formatter = vi.fn(() => 'unused')
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    try {
      expect(prepareComputerCliJsonResult(response)).toBe(response)
      printResult(response, true, formatter)
      expect(logSpy).toHaveBeenCalledOnce()
      expect(logSpy).toHaveBeenCalledWith(JSON.stringify(response, null, 2))
      expect(formatter).not.toHaveBeenCalled()
    } finally {
      logSpy.mockRestore()
    }
  })

  it.each([
    { result: {} },
    { result: [] },
    { result: { screenshotStatus: {} } },
    { result: { screenshot: { data: 'cG5n', format: 'png' } } }
  ])('preserves object results without a computer screenshot: %j', ({ result }) => {
    const response = {
      id: 'req-object',
      ok: true as const,
      result,
      _meta: { runtimeId: 'runtime-1' }
    }

    expect(prepareComputerCliJsonResult(response)).toBe(response)
  })
})

describe('formatComputerAction', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does not treat legacy action results without metadata as completed', () => {
    const result: ComputerActionResult = {
      snapshot: {
        id: 'snap-1',
        app: { name: 'Finder', bundleId: 'com.apple.finder', pid: 100 },
        window: { title: 'Finder', id: 42, width: 800, height: 600 },
        coordinateSpace: 'window',
        treeText: 'tree',
        elementCount: 5,
        focusedElementId: null
      },
      screenshot: null,
      screenshotStatus: { state: 'skipped', reason: 'no_screenshot_flag' }
    }

    const output = formatComputerAction('click', result)

    expect(output).toContain('Click attempted, unverified (verification metadata unavailable)')
    expect(output).toContain('Inspect with the command above')
    expect(output).not.toContain('Click completed')
  })

  it('does not treat accessibility actions without verification as completed', () => {
    const result: ComputerActionResult = {
      snapshot: {
        id: 'snap-1',
        app: { name: 'Finder', bundleId: 'com.apple.finder', pid: 100 },
        window: { title: 'Finder', id: 42, width: 800, height: 600 },
        coordinateSpace: 'window',
        treeText: 'tree',
        elementCount: 5,
        focusedElementId: null
      },
      screenshot: null,
      screenshotStatus: { state: 'skipped', reason: 'no_screenshot_flag' },
      action: {
        path: 'accessibility',
        actionName: 'click',
        targetWindowId: 42
      }
    }

    const output = formatComputerAction('click', result)

    expect(output).toContain(
      'Click attempted via accessibility, unverified (accessibility action unasserted)'
    )
    expect(output).toContain('Inspect with the command above')
    expect(output).not.toContain('Click completed')
  })

  it('quotes worktree selectors so a pasted Windows command keeps dollar signs', () => {
    const result: ComputerActionResult = {
      snapshot: {
        id: 'snap-1',
        app: { name: 'App', bundleId: 'com.example.app', pid: 100 },
        window: { title: 'App', id: 42, width: 800, height: 600 },
        coordinateSpace: 'window',
        treeText: 'tree',
        elementCount: 5,
        focusedElementId: null
      },
      screenshot: null,
      screenshotStatus: { state: 'skipped', reason: 'no_screenshot_flag' },
      action: {
        path: 'synthetic',
        verification: { state: 'verified', property: 'value' }
      }
    }

    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const output = formatComputerAction('click', result, {
      worktree: 'path:C:/work/$review'
    })

    expect(output).toContain('--worktree path:C:/work/$"r"eview')
  })
})
