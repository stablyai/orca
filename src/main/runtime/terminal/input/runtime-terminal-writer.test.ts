import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeTerminalWriter } from './runtime-terminal-writer'

import {
  WRITE_ACCEPTED,
  type WriteSettlement
} from '../../../../shared/terminal/pty/lifecycle/pty-write-settlement'
import { TERMINAL_INPUT_CHUNK_MAX_BYTES } from '../../../../shared/terminal/input/terminal-input'

afterEach(() => vi.useRealTimers())

describe('requested terminal write settlement', () => {
  it('waits for complete body settlement before suffix and host acknowledgment', async () => {
    vi.useFakeTimers()
    const raw = vi.fn((_id: string, _data: string) => true)
    const bytes: string[] = []
    let finish: (result: WriteSettlement) => void = () => {
      throw new Error('write not started')
    }
    const settled = vi.fn((_id: string, data: string) => {
      bytes.push(data)
      return bytes.length === 1
        ? new Promise<WriteSettlement>((resolve) => {
            finish = resolve
          })
        : WRITE_ACCEPTED
    })
    const writer = new RuntimeTerminalWriter(
      raw,
      () => 'linux',
      () => null,
      settled
    )
    const text = 'x'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES + 1)
    const pending = writer.writeAction('pty', { text, enter: true }, `${text}\r`, {
      inputKind: 'driving',
      requireWriteSettlement: true
    })
    await vi.advanceTimersByTimeAsync(2000)
    expect(bytes).toHaveLength(1)
    finish(WRITE_ACCEPTED)
    await vi.advanceTimersByTimeAsync(2000)
    await expect(pending).resolves.toEqual(WRITE_ACCEPTED)
    expect(bytes.join('')).toBe(`${text}\r`)
    expect(bytes.at(-1)).toBe('\r')
    expect(raw).not.toHaveBeenCalled()
  })
})

describe('submit settle before Enter', () => {
  /** An idle proof the test settles by hand, after advancing the fake clock. */
  function heldProof(): { claim: () => Promise<boolean>; settle: (idle: boolean) => void } {
    let settle: (idle: boolean) => void = () => {
      throw new Error('proof not started')
    }
    const proof = new Promise<boolean>((resolve) => {
      settle = resolve
    })
    return { claim: () => proof, settle: (idle) => settle(idle) }
  }

  it('does not submit when the send is cancelled during a successful idle proof', async () => {
    vi.useFakeTimers()
    const writes: string[] = []
    const controller = new AbortController()
    const proof = heldProof()
    const writer = new RuntimeTerminalWriter(
      (_id, data) => {
        writes.push(data)
        return true
      },
      () => 'linux',
      () => null,
      undefined,
      proof.claim
    )
    const pending = writer.writeAction('pty', { text: 'ls', enter: true }, 'ls\r', {
      inputKind: 'driving',
      signal: controller.signal
    })
    const rejected = expect(pending).rejects.toThrow('request_aborted')
    await vi.advanceTimersByTimeAsync(100)
    controller.abort()
    proof.settle(true)
    await vi.advanceTimersByTimeAsync(1000)
    await rejected
    expect(writes).toEqual(['ls'])
  })
})

describe('Enter after text for a Windows input-record agent', () => {
  it('caps the burst wait so a long message still answers inside a phone RPC timeout', async () => {
    vi.useFakeTimers()
    const startedAt = Date.now()
    let enterAt: number | undefined
    const writer = new RuntimeTerminalWriter(
      (_id, data) => {
        if (data === '\r') {
          enterAt = Date.now() - startedAt
        }
        return true
      },
      () => 'win32',
      () => 'codex'
    )
    // 10k chars would be a 30 s burst wait uncapped, past the phone's 30 s terminal.send timeout.
    const text = 'm'.repeat(10_000)
    const pending = writer.writeAction('pty', { text, enter: true }, `${text}\r`, {
      inputKind: 'driving'
    })
    await vi.runAllTimersAsync()
    await pending
    expect(enterAt).toBeGreaterThanOrEqual(19_000)
    expect(enterAt).toBeLessThanOrEqual(20_000)
  })
})
