import { afterEach, describe, expect, it, vi } from 'vitest'
import { constants } from 'node:os'
import type * as Os from 'node:os'

const setPriorityMock = vi.hoisted(() => vi.fn())

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof Os>()
  return {
    ...actual,
    setPriority: setPriorityMock
  }
})

import { resetLinuxPtyChildPriority } from './linux-pty-child-priority'

function setPlatform(platform: NodeJS.Platform): () => void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  return () => {
    if (original) {
      Object.defineProperty(process, 'platform', original)
    }
  }
}

describe('resetLinuxPtyChildPriority', () => {
  let restorePlatform: (() => void) | null = null

  afterEach(() => {
    restorePlatform?.()
    restorePlatform = null
    setPriorityMock.mockReset()
  })

  it('sets the child to PRIORITY_NORMAL on Linux without touching this process', () => {
    restorePlatform = setPlatform('linux')

    expect(resetLinuxPtyChildPriority(4242)).toBe(true)
    expect(setPriorityMock).toHaveBeenCalledTimes(1)
    expect(setPriorityMock).toHaveBeenCalledWith(4242, constants.priority.PRIORITY_NORMAL)
    expect(setPriorityMock.mock.calls[0]?.[0]).not.toBe(process.pid)
  })

  it('leaves darwin and win32 children on the inherited priority', () => {
    for (const platform of ['darwin', 'win32'] as const) {
      restorePlatform?.()
      restorePlatform = setPlatform(platform)
      setPriorityMock.mockClear()

      expect(resetLinuxPtyChildPriority(4242)).toBe(false)
      expect(setPriorityMock).not.toHaveBeenCalled()
    }
  })

  it('ignores missing or invalid child pids', () => {
    restorePlatform = setPlatform('linux')

    expect(resetLinuxPtyChildPriority(undefined)).toBe(false)
    expect(resetLinuxPtyChildPriority(0)).toBe(false)
    expect(resetLinuxPtyChildPriority(-1)).toBe(false)
    expect(setPriorityMock).not.toHaveBeenCalled()
  })

  it('swallows setPriority failures so spawn still succeeds', () => {
    restorePlatform = setPlatform('linux')
    setPriorityMock.mockImplementation(() => {
      throw new Error('EPERM')
    })

    expect(resetLinuxPtyChildPriority(4242)).toBe(false)
  })
})
