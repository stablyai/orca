import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { wslMoveCutoverFixture } from '../../__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../../__fixtures__/wsl-mover/wsl-move-journal-seeding'
import { listWslMoveCutovers } from './wsl-move-cutover-journal'
import { WSL_MOVE_HOST_AUTOMATION_TURN_DEADLINE_MS } from './wsl-move-host-automations-lock'
import { retryWslMoveHostAutomationsLeftOff } from './wsl-move-undo-host-automations'

let userDataPath: string
beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'wsl-move-undo-host-automations-'))
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('the retry of host automations a refused undo left off', () => {
  it('keeps only the ones still off when the host hangs past the deadline', async () => {
    vi.useFakeTimers()
    seedWslMoveCutover(
      userDataPath,
      wslMoveCutoverFixture('move-1', 'client-rewritten', {
        hostAutomationsLeftOff: ['auto-1', 'auto-2']
      })
    )
    // auto-1 turns on, then the host stops answering; at the deadline the error names auto-2.
    const restore = vi.fn(
      (_env: string, _ids: readonly string[], signal?: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { leftOff: ['auto-2'] }))
          )
        })
    )
    const retry = retryWslMoveHostAutomationsLeftOff(userDataPath, {
      restore,
      disable: async () => []
    })
    await vi.advanceTimersByTimeAsync(WSL_MOVE_HOST_AUTOMATION_TURN_DEADLINE_MS)
    await expect(retry).resolves.toBe(true)
    // auto-1 is on: a later retry must not turn it on over the user's own choice since.
    expect(listWslMoveCutovers(userDataPath)[0]?.hostAutomationsLeftOff).toEqual(['auto-2'])
  })
})
