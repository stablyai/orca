import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import { CodeIntelSidecarClient } from './sidecar-client'
import type { SidecarRequest, SidecarResponse } from './sidecar-protocol'

class FakeChild extends EventEmitter {
  killed = false
  sent: SidecarRequest[] = []
  send(message: SidecarRequest, cb?: (err: Error | null) => void): boolean {
    this.sent.push(message)
    cb?.(null)
    if (message.kind === 'query') {
      queueMicrotask(() => {
        const response: SidecarResponse = {
          id: message.id,
          ok: true,
          result: { status: 'ok', bufferVersion: 0, locations: [], truncated: false }
        }
        this.emit('message', response)
      })
    }
    return true
  }
  kill(): boolean {
    this.killed = true
    return true
  }
}

let fake: FakeChild

afterEach(() => vi.restoreAllMocks())

describe('CodeIntelSidecarClient', () => {
  it('resolves a query with the sidecar result', async () => {
    fake = new FakeChild()
    const client = new CodeIntelSidecarClient('/fake/entry.js', () => fake as never)
    const result = await client.query('references', {
      filePath: '/repo/a.ts',
      relativePath: 'a.ts',
      position: { line: 0, character: 0 },
      bufferVersion: 0
    })
    expect(result).toEqual({ status: 'ok', bufferVersion: 0, locations: [], truncated: false })
    client.shutdown()
  })

  it('sends a cancel envelope when the abort signal fires', async () => {
    fake = new FakeChild()
    fake.send = function (
      this: FakeChild,
      message: SidecarRequest,
      cb?: (err: Error | null) => void
    ) {
      this.sent.push(message)
      cb?.(null)
      return true
    } as never
    const client = new CodeIntelSidecarClient('/fake/entry.js', () => fake as never)
    const controller = new AbortController()
    const pending = client
      .query(
        'references',
        {
          filePath: '/repo/a.ts',
          relativePath: 'a.ts',
          position: { line: 0, character: 0 },
          bufferVersion: 0
        },
        controller.signal
      )
      .catch(() => 'rejected')
    controller.abort()
    await pending
    expect(fake.sent.some((m) => m.kind === 'cancel')).toBe(true)
    client.shutdown()
  })
})
