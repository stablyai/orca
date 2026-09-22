import { describe, expect, it } from 'vitest'
import type { ComputerActionResult } from '../shared/runtime-types'
import { formatComputerAction } from './computer-format'

describe('formatComputerAction', () => {
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
})
