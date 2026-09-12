import { expect, it, vi } from 'vitest'
import {
  hasOrcadLifecycleOutputLine,
  verifyOrcadLifecycleTerminalRoundTrip
} from './orcad-bun-lifecycle-terminal-probe.mjs'

vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn(async () => {}) }))

const marker = 'ORCAD_BUN_LIFECYCLE_test'

it('requires a complete output line, not echoed input or unrelated response metadata', () => {
  expect(hasOrcadLifecycleOutputLine({ terminal: { tail: [`$ echo ${marker}`] } }, marker)).toBe(
    false
  )
  expect(hasOrcadLifecycleOutputLine({ marker, terminal: { tail: [] } }, marker)).toBe(false)
  expect(
    hasOrcadLifecycleOutputLine({ terminal: { tail: [`before${marker}after`] } }, marker)
  ).toBe(false)
  expect(hasOrcadLifecycleOutputLine({ terminal: { tail: [`${marker}\r`] } }, marker)).toBe(true)
})

it('waits for writable state before submitting fresh input and reading its result', async () => {
  const events = []
  await verifyOrcadLifecycleTerminalRoundTrip({
    marker,
    waitForWritable: async () => {
      events.push('writable')
    },
    send: async (command) => {
      events.push(command)
    },
    read: async () => {
      events.push('read')
      return { terminal: { tail: [marker] } }
    }
  })
  expect(events).toEqual(['writable', `echo ${marker}`, 'read'])
})

it('never submits input when reattachment did not restore writability', async () => {
  const send = vi.fn()
  const read = vi.fn()
  await expect(
    verifyOrcadLifecycleTerminalRoundTrip({
      marker,
      waitForWritable: async () => {
        throw new Error('not writable')
      },
      send,
      read
    })
  ).rejects.toThrow('not writable')
  expect(send).not.toHaveBeenCalled()
  expect(read).not.toHaveBeenCalled()
})

it('fails bounded observation of old output and echoed input without resending', async () => {
  const send = vi.fn()
  const read = vi.fn(async () => ({ terminal: { tail: [marker, `echo ${marker}_restart`] } }))
  await expect(
    verifyOrcadLifecycleTerminalRoundTrip({
      marker: `${marker}_restart`,
      waitForWritable: async () => {},
      send,
      read
    })
  ).rejects.toThrow('did not execute lifecycle probe')
  expect(send).toHaveBeenCalledExactlyOnceWith(`echo ${marker}_restart`)
  expect(read).toHaveBeenCalledTimes(30)
})
