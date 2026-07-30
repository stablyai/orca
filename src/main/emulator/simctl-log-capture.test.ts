import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

const spawnMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ spawn: spawnMock }))

import { captureSimulatorLog } from './simctl-log-capture'

function mockChild(): EventEmitter & {
  stdout: PassThrough
  stderr: PassThrough
  kill: ReturnType<typeof vi.fn>
} {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn()
  })
}

describe('captureSimulatorLog', () => {
  beforeEach(() => {
    spawnMock.mockReset()
  })

  it('streams, parses, and keeps only the requested tail', async () => {
    const child = mockChild()
    spawnMock.mockReturnValue(child)
    const capture = captureSimulatorLog('device-1', { lines: 2 })
    child.stdout.write(
      '{"timestamp":"one","messageType":"Info","eventMessage":"first"}\nnot json\n' +
        '{"timestamp":"two","messageType":"Error","eventMessage":"sec'
    )
    child.stdout.write('ond"}\n{"timestamp":"three","messageType":"Fault","eventMessage":"third"}')
    child.emit('close', 0, null)

    await expect(capture).resolves.toEqual([
      { timestamp: 'two', level: 'Error', message: 'second' },
      { timestamp: 'three', level: 'Fault', message: 'third' }
    ])
    expect(spawnMock).toHaveBeenCalledWith(
      'xcrun',
      expect.arrayContaining(['simctl', 'spawn', 'device-1', 'log', 'show', '--style', 'ndjson']),
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
  })

  it('maps unavailable simctl errors', async () => {
    const child = mockChild()
    spawnMock.mockReturnValue(child)
    const capture = captureSimulatorLog('device-1')
    child.emit('error', Object.assign(new Error('spawn xcrun ENOENT'), { code: 'ENOENT' }))

    await expect(capture).rejects.toMatchObject({
      code: 'emulator_simctl_unavailable'
    })
  })
})
