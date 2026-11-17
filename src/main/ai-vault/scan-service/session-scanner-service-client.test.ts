import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiVaultScannerServiceClient } from './session-scanner-service-client'

class ScannerChild extends EventEmitter {
  readonly stderr = Object.assign(new EventEmitter(), { setEncoding: () => {} })
  readonly sent: Record<string, unknown>[] = []
  connected = true
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null

  constructor(readonly pid: number) {
    super()
  }

  send(message: Record<string, unknown>, callback?: () => void): boolean {
    this.sent.push(message)
    callback?.()
    return true
  }

  kill(): boolean {
    return true
  }

  unref(): void {}

  requestId(): number {
    const id = this.sent.find((message) => message.type === 'request')?.id
    return typeof id === 'number' ? id : -1
  }

  // What V8 does when the heap is exhausted: print the fatal line, abort, close stdio.
  abortOutOfMemory(): void {
    this.stderr.emit(
      'data',
      'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n'
    )
    this.connected = false
    this.signalCode = 'SIGABRT'
    this.emit('disconnect')
    this.emit('exit', null, 'SIGABRT')
    this.emit('close', null, 'SIGABRT')
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('AiVaultScannerServiceClient', () => {
  it('reruns a scan that exhausted the scanner heap on a child given more heap', async () => {
    vi.useFakeTimers()
    const children: ScannerChild[] = []
    const heapRetries: boolean[] = []
    const client = new AiVaultScannerServiceClient({
      processFactory: ({ afterOutOfMemory }) => {
        heapRetries.push(afterOutOfMemory)
        const child = new ScannerChild(100 + children.length)
        children.push(child)
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the client only uses the ChildProcess members ScannerChild implements.
        return child as unknown as ChildProcess
      },
      init: () => ({ sessionParseCache: null, sessionSearch: null })
    })
    const scan = client.request({ type: 'request', operation: 'scan', options: {} })

    children[0]!.emit('message', { type: 'ready', protocol: 1, pid: 100 })
    await vi.advanceTimersByTimeAsync(0)
    children[0]!.abortOutOfMemory()
    await vi.advanceTimersByTimeAsync(1_000)
    children[1]!.emit('message', { type: 'ready', protocol: 1, pid: 101 })
    await vi.advanceTimersByTimeAsync(0)
    const value = { result: { sessions: [], issues: [], scannedAt: 'now' }, durationMs: 1 }
    children[1]!.emit('message', {
      type: 'result',
      id: children[1]!.requestId(),
      operation: 'scan',
      value
    })

    await expect(scan).resolves.toEqual(value)
    expect(heapRetries).toEqual([false, true])
    client.dispose()
  })
})
