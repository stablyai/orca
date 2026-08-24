import { afterEach, describe, expect, it, vi } from 'vitest'
import { printHelp } from '../help'
import { AUTOMATION_COMMAND_SPECS } from './automations'

describe('automation command help', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each([
    ['create', '--linked-task <json>'],
    ['edit', '--linked-task <json|null>']
  ])('advertises linked-task for automations %s', (command, expectedUsage) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    printHelp(AUTOMATION_COMMAND_SPECS, ['automations', command])

    expect(String(log.mock.calls[0]?.[0])).toContain(expectedUsage)
  })
})
