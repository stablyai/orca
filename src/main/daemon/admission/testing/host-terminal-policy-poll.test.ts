import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { HostTerminalPolicy } from '../host-terminal-policy'
import { SystemPtyLimit } from '../system-pty-limit'

let directory: string | undefined
afterEach(() => {
  vi.useRealTimers()
  if (directory) {
    rmSync(directory, { recursive: true, force: true })
  }
})

it('keeps the post-save 3s poll when a poll that started before the save finishes afterwards', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  directory = mkdtempSync(join(tmpdir(), 'terminal-policy-poll-'))
  mkdirSync(join(directory, 'policy'), { mode: 0o700 })
  let disk = 4
  let reads = 0
  let releaseSecondRead: () => void = () => {}
  const secondReadGate = new Promise<void>((resolve) => (releaseSecondRead = resolve))
  const policy = new HostTerminalPolicy(
    join(directory, 'policy', 'terminals.json'),
    {},
    new SystemPtyLimit(async () => 511),
    async () => {
      reads += 1
      const value = disk
      if (reads === 2) {
        await secondReadGate
      }
      return value
    }
  )
  await policy.start()

  await vi.advanceTimersByTimeAsync(3_000)
  await policy.save(4, () => true)
  releaseSecondRead()
  await vi.advanceTimersByTimeAsync(0)

  disk = 7
  await vi.advanceTimersByTimeAsync(3_000)
  expect(policy.admissionMaximum()).toBe(7)
  policy.dispose()
})
