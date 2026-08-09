import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { waitForJsDebugListeningPort } from './js-debug-listening-port'

describe('waitForJsDebugListeningPort', () => {
  it('parses the port out of the "Debug server listening at" line', async () => {
    const stdout = new PassThrough()
    const pending = waitForJsDebugListeningPort(stdout, 1000)
    stdout.write('some startup noise\n')
    stdout.write('Debug server listening at 127.0.0.1:54213\n')
    await expect(pending).resolves.toBe(54213)
  })

  it('handles the listening line arriving split across chunks', async () => {
    const stdout = new PassThrough()
    const pending = waitForJsDebugListeningPort(stdout, 1000)
    stdout.write('Debug server list')
    stdout.write('ening at 127.0.0.1:9999\n')
    await expect(pending).resolves.toBe(9999)
  })

  it('rejects if the process closes before reporting a port', async () => {
    const stdout = new PassThrough()
    const pending = waitForJsDebugListeningPort(stdout, 1000)
    stdout.end()
    await expect(pending).rejects.toThrow(/closed/)
  })

  it('rejects on timeout when nothing is ever written', async () => {
    const stdout = new PassThrough()
    await expect(waitForJsDebugListeningPort(stdout, 20)).rejects.toThrow(/Timed out/)
  })
})
