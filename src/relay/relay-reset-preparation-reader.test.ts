import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PassThrough, Readable } from 'node:stream'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { RelayOwnerResetPreparationJournal } from './relay-owner-reset-preparation-journal'
import {
  isRelayResetPreparationReadMode,
  readRelayResetPreparation,
  readRelayResetPreparationStdin,
  RELAY_RESET_PREPARATION_READ_FLAG
} from './relay-reset-preparation-reader'

let directory: string
const request = {
  version: 1 as const,
  operationId: 'reset',
  runtimeIncarnation: 'runtime',
  ownerGeneration: 1,
  ownerLease: 'private-owner-lease'
}
const journal = () => new RelayOwnerResetPreparationJournal(directory, '/socket', 'build')
const envelope = () => ({
  version: 1,
  binding: journal().describe('owner', 'endpoint-credential'),
  request
})
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-reset-read-'))
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(directory, { recursive: true, force: true })
})

it('requires an exclusive reader mode and rejects combinations before normal mode selection', () => {
  expect(
    isRelayResetPreparationReadMode(['bun', 'relay.js', RELAY_RESET_PREPARATION_READ_FLAG])
  ).toBe(true)
  expect(isRelayResetPreparationReadMode(['bun', 'relay.js', '--connect'])).toBe(false)
  for (const extra of ['--connect', '--detached', '--orca-cli', '--sock-path']) {
    expect(() =>
      isRelayResetPreparationReadMode(['bun', 'relay.js', extra, RELAY_RESET_PREPARATION_READ_FLAG])
    ).toThrow('arguments_invalid')
  }
})

it('reads preparation after writer recreation without changing journal bytes', async () => {
  journal().persist(request, 'owner', 'endpoint-credential', () => {})
  const file = join(directory, readdirSync(directory)[0])
  const before = readFileSync(file, 'utf8')
  const output = await readRelayResetPreparationStdin(Readable.from([JSON.stringify(envelope())]))
  expect(JSON.parse(output)).toEqual({ version: 1, preparation: journal().read(request) })
  expect(readFileSync(file, 'utf8')).toBe(before)
  expect(readdirSync(directory)).toHaveLength(1)
})

it('reports missing evidence without creating a directory or inventing preparation', async () => {
  const value = envelope()
  value.binding = { ...value.binding, journalDirectory: join(directory, 'missing') }
  expect(readRelayResetPreparation(value)).toEqual({ version: 1, preparation: null })
  expect(readdirSync(directory)).toEqual([])
})

it('requires the exact recorded principal and owner lease', () => {
  journal().persist(request, 'owner', 'endpoint-credential', () => {})
  const value = envelope()
  expect(() =>
    readRelayResetPreparation({ ...value, binding: { ...value.binding, principal: 'other' } })
  ).toThrow('conflict')
  expect(() =>
    readRelayResetPreparation({ ...value, request: { ...request, ownerLease: 'other' } })
  ).toThrow('conflict')
})

it('refuses relative journal paths rather than depending on the reader cwd', () => {
  const value = envelope()
  expect(() =>
    readRelayResetPreparation({
      ...value,
      binding: { ...value.binding, journalDirectory: 'relative' }
    })
  ).toThrow('directory_invalid')
})

it('bounds stdin and suppresses credential-bearing parse errors', async () => {
  await expect(
    readRelayResetPreparationStdin(Readable.from([Buffer.alloc(64 * 1024 + 1)]))
  ).rejects.toThrow('read_failed')
  await expect(
    readRelayResetPreparationStdin(Readable.from(['private-owner-lease is invalid JSON']))
  ).rejects.toThrow(/^relay_reset_preparation_read_failed$/)
})

it('times out a reader whose input never ends', async () => {
  vi.useFakeTimers()
  const input = new PassThrough()
  const result = readRelayResetPreparationStdin(input)
  const rejection = expect(result).rejects.toThrow('read_failed')
  await vi.advanceTimersByTimeAsync(10_000)
  await rejection
  expect(input.destroyed).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})
