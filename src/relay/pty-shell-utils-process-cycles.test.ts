import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getProcessTableIndex } from '../shared/process-table-index'
import type { ProcessTableRow } from '../shared/process-table-snapshot'
import { getProcessTableSnapshot } from '../shared/process-table-snapshot-reader'
import { getForegroundProcessName } from './pty-shell-utils'

vi.mock(import('../shared/process-table-snapshot-reader'), async (importOriginal) => ({
  ...(await importOriginal()),
  getProcessTableSnapshot: vi.fn()
}))

function row(pid: number, ppid: number, command = 'bash'): ProcessTableRow {
  return { pid, ppid, stat: 'S+', command }
}

describe('relay foreground process snapshot cycles', () => {
  let platform: PropertyDescriptor | undefined

  beforeEach(() => {
    platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (platform) {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it.each([
    ['a self-parented root', [row(100, 100), row(101, 100, 'node /usr/bin/codex')]],
    ['a two-process cycle', [row(100, 101), row(101, 100, 'node /usr/bin/codex')]],
    [
      'duplicate rows',
      [row(100, 1), row(101, 100, 'node /usr/bin/codex'), row(101, 100, 'node /usr/bin/codex')]
    ],
    ['an ordinary tree', [row(100, 1), row(101, 100, 'node /usr/bin/codex')]]
  ])('resolves the agent once for %s', async (_name, rows) => {
    vi.mocked(getProcessTableSnapshot).mockResolvedValue(rows)
    const children = getProcessTableIndex(rows).childrenByPpid
    const readChildren = children.get.bind(children)
    let reads = 0
    vi.spyOn(children, 'get').mockImplementation((pid) => {
      // Bound the regression itself so removing the guard cannot OOM the test worker.
      if (++reads > 20) {
        throw new Error('process snapshot traversal did not terminate')
      }
      return readChildren(pid)
    })

    await expect(getForegroundProcessName(100, 'node')).resolves.toBe('codex')
    expect(reads).toBeLessThanOrEqual(rows.length)
  })
})
