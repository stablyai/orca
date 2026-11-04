import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { JsonlRpcRecord } from '../jsonl-rpc/peer'
import { PiRpcBackgroundWork } from './rpc-background-work'

const folders: string[] = []
afterEach(() => {
  vi.useRealTimers()
  folders.splice(0).forEach((folder) => rmSync(folder, { recursive: true, force: true }))
})

// Recorded on Windows from Pi 1.5.0 + pi-subagents 0.84.0 + the bridge: ready, an answer while a
// worker ran, an answer after its wake turn settled, and shutdown.
const [ready, busy, idle, gone] = readFileSync(
  join(import.meta.dirname, '__fixtures__', 'background-work.jsonl'),
  'utf8'
)
  .split('\n')
  .filter(Boolean)
  .map((line): JsonlRpcRecord => JSON.parse(JSON.parse(line).raw))

function probeFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), 'orca-pi-probe-'))
  folders.push(folder)
  return folder
}

/** Answer Orca's pending request with a recorded reply, carrying the nonce Orca chose. */
async function answer(work: PiRpcBackgroundWork, folder: string, recorded: JsonlRpcRecord) {
  await vi.waitFor(() =>
    expect(readdirSync(folder).some((name) => name.endsWith('.probe'))).toBe(true)
  )
  const nonce = readdirSync(folder)
    .find((name) => name.endsWith('.probe'))!
    .split('.')[1]
  const [kind, instance, , state] = String(recorded.statusText).split(':')
  work.receive({ ...recorded, statusText: [kind, instance, nonce, state].join(':') })
}

it('stops only on a fresh idle answer from the bridge instance that is ready now', async () => {
  const folder = probeFolder()
  const work = new PiRpcBackgroundWork(folder)
  await expect(work.confirmIdle()).resolves.toBe('unknown')
  expect(work.receive(ready)).toBe(true)

  const whileRunning = work.confirmIdle()
  await answer(work, folder, busy)
  await expect(whileRunning).resolves.toBe('busy')
  const afterWake = work.confirmIdle()
  await answer(work, folder, idle)
  await expect(afterWake).resolves.toBe('idle')
  expect(readdirSync(folder)).toEqual([])

  work.receive(gone)
  await expect(work.confirmIdle()).resolves.toBe('unknown')
  await expect(new PiRpcBackgroundWork(null).confirmIdle()).resolves.toBe('idle')
})

it('never reads an unanswered, unasked-for or malformed reply as idle', async () => {
  const folder = probeFolder()
  const work = new PiRpcBackgroundWork(folder)
  work.receive(ready)
  const readyInstance = String(ready.statusText).split(':')[1]
  expect(work.receive({ ...idle, statusText: `answer:${readyInstance}` })).toBe(true)
  vi.useFakeTimers({ toFake: ['setTimeout'] })
  const unanswered = work.confirmIdle()
  await vi.waitFor(() => expect(readdirSync(folder)).toHaveLength(1))
  const [instance, nonce] = readdirSync(folder)[0].split('.')
  work.receive({ ...idle, statusText: `answer:${instance}:${nonce}:idle:extra` })
  vi.advanceTimersByTime(5_000)
  await expect(unanswered).resolves.toBe('unknown')
})
