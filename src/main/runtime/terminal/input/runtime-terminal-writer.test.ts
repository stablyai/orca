import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeTerminalWriter } from './runtime-terminal-writer'
import { isTerminalInputPaused } from './terminal-input-admission'
import { terminalInputSourceForClient } from '../../rpc/methods/terminal/terminal-input-delivery'
import {
  WRITE_ACCEPTED,
  writeRefused,
  writeUnverifiable,
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

  it.each([
    writeRefused('endpoint_disconnected'),
    writeUnverifiable('transport_settlement_lost', true)
  ])('preserves first-write $outcome and never sends a suffix', async (verdict) => {
    const raw = vi.fn((_id: string, _data: string) => true)
    const settled = vi.fn(() => verdict)
    const writer = new RuntimeTerminalWriter(
      raw,
      () => 'linux',
      () => null,
      settled
    )
    await expect(
      writer.writeAction('pty', { text: 'body', enter: true }, 'body\r', {
        inputKind: 'driving',
        requireWriteSettlement: true
      })
    ).resolves.toEqual(verdict)
    expect(settled).toHaveBeenCalledOnce()
    expect(raw).not.toHaveBeenCalled()
  })

  it('keeps a later refusal unknown after an acknowledged prefix', async () => {
    const settled = vi
      .fn()
      .mockReturnValueOnce(WRITE_ACCEPTED)
      .mockReturnValueOnce(writeRefused('transport_queue_full'))
    const writer = new RuntimeTerminalWriter(
      () => true,
      () => 'linux',
      () => null,
      settled
    )
    const text = 'x'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES + 1)
    await expect(
      writer.writeAction('pty', { text, enter: true }, `${text}\r`, {
        inputKind: 'driving',
        requireWriteSettlement: true
      })
    ).resolves.toMatchObject({
      outcome: 'unverifiable',
      reason: 'partial_write',
      bytesHandedToTransport: true
    })
    expect(settled).toHaveBeenCalledTimes(2)
  })

  it.each(['afterWrite', 'beforeSuffix'] as const)(
    'keeps a %s failure unknown after handing off bytes',
    async (failure) => {
      vi.useFakeTimers()
      const settled = vi.fn(() => WRITE_ACCEPTED)
      let calls = 0
      const writer = new RuntimeTerminalWriter(
        () => true,
        () => 'linux',
        () => null,
        settled
      )
      const pending = writer.writeAction('pty', { text: 'body', enter: true }, 'body\r', {
        inputKind: 'driving',
        requireWriteSettlement: true,
        beforeWrite: () => {
          if (++calls > 1 && failure === 'beforeSuffix') {
            throw new Error('terminal_not_writable')
          }
        },
        afterWrite: () => {
          if (failure === 'afterWrite') {
            throw new Error('bookkeeping failed')
          }
        }
      })
      await vi.advanceTimersByTimeAsync(1000)
      await expect(pending).resolves.toMatchObject({
        outcome: 'unverifiable',
        bytesHandedToTransport: true
      })
      expect(settled).toHaveBeenCalledOnce()
    }
  )

  it('refuses a requested settlement before raw writes when the provider cannot settle', async () => {
    const raw = vi.fn((_id: string, _data: string) => true)
    const writer = new RuntimeTerminalWriter(raw)
    await expect(
      writer.writeAction('pty', { text: 'choice' }, 'choice', {
        inputKind: 'driving',
        requireWriteSettlement: true
      })
    ).resolves.toEqual(writeRefused('provider_cannot_settle'))
    expect(raw).not.toHaveBeenCalled()
  })

  it('preserves legacy raw body and Enter requests without adding provider waits', async () => {
    vi.useFakeTimers()
    const raw = vi.fn((_id: string, _data: string) => true)
    const settled = vi.fn(() => WRITE_ACCEPTED)
    const writer = new RuntimeTerminalWriter(
      raw,
      () => 'linux',
      () => null,
      settled
    )
    const pending = writer.writeAction('pty', { text: 'body', enter: true }, 'body\r', {
      inputKind: 'driving'
    })
    await vi.advanceTimersByTimeAsync(1000)
    await expect(pending).resolves.toBeUndefined()
    expect(raw.mock.calls.map((call) => call[1])).toEqual(['body', '\r'])
    expect(settled).not.toHaveBeenCalled()
  })
})

it.each([
  ['desktop', { kind: 'desktop' }, { id: 'desktop', type: 'desktop' }],
  ['local CLI', { kind: 'local-cli' }, { id: 'orca-cli', type: 'desktop' }],
  ['paired CLI', { kind: 'paired-device', deviceId: 'cli' }, { id: 'orca-cli', type: 'desktop' }],
  ['orchestration', undefined, undefined],
  ['mobile', { kind: 'paired-device', deviceId: 'phone' }, { id: 'phone', type: 'mobile' }],
  ['legacy', { kind: 'paired-device', deviceId: 'old' }, undefined],
  ['unknown', { kind: 'paired-device', deviceId: 'other' }, { id: 'unknown' }]
] as const)('admits %s by source and driver', (source, caller, client) => {
  const inputSource =
    source === 'orchestration' ? undefined : terminalInputSourceForClient(client, caller)
  for (const phone of [false, true]) {
    const runtime = {
      getDriver: () =>
        phone ? { kind: 'mobile' as const, clientId: 'phone' } : { kind: 'desktop' as const }
    }
    expect(isTerminalInputPaused(runtime, 'pty', inputSource)).toBe(
      phone && ['desktop', 'unknown'].includes(source)
    )
  }
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

  async function submitTimes(text: string, idleShell: boolean, proofMs = 0): Promise<number[]> {
    vi.useFakeTimers()
    const startedAt = Date.now()
    const enters: number[] = []
    const proof = heldProof()
    const writer = new RuntimeTerminalWriter(
      (_id, data) => {
        if (data === '\r') {
          enters.push(Date.now() - startedAt)
        }
        return true
      },
      () => 'linux',
      () => null,
      undefined,
      proof.claim
    )
    const pending = writer.writeAction('pty', { text, enter: true }, `${text}\r`, {
      inputKind: 'driving'
    })
    await vi.advanceTimersByTimeAsync(proofMs)
    proof.settle(idleShell)
    await vi.advanceTimersByTimeAsync(5000)
    await pending
    return enters
  }

  it('skips the settle for a single line sent to an idle shell prompt', async () => {
    expect(await submitTimes('ls -la', true)).toEqual([0])
  })

  it('keeps the settle when the pane is not provably an idle shell', async () => {
    const [at] = await submitTimes('ls -la', false)
    expect(at).toBeGreaterThanOrEqual(500)
  })

  it('keeps the settle for multi-line text even at an idle prompt', async () => {
    const [at] = await submitTimes('echo one\necho two', true)
    expect(at).toBeGreaterThanOrEqual(500)
  })

  it('counts a failed idle proof toward the settle instead of adding to it', async () => {
    const [unproven] = await submitTimes('ls -la', false)
    const [slowProof] = await submitTimes('ls -la', false, 250)
    expect(slowProof).toBe(unproven)
  })

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
  // Windows Codex reads typed text as key events and takes an Enter that lands mid-burst as a newline.
  it('waits out the key-event burst before Enter on a mobile-sized message', async () => {
    vi.useFakeTimers()
    const raw = vi.fn((_id: string, _data: string) => true)
    const writer = new RuntimeTerminalWriter(
      raw,
      () => 'win32',
      () => 'codex'
    )
    const text = 'm'.repeat(2_015)
    const pending = writer.writeAction('pty', { text, enter: true }, `${text}\r`, {
      inputKind: 'driving'
    })
    await vi.advanceTimersByTimeAsync(2_015 * 3)
    expect(raw.mock.calls.map((call) => call[1])).toEqual([text])
    await vi.runAllTimersAsync()
    await pending
    expect(raw.mock.calls.map((call) => call[1])).toEqual([text, '\r'])
  })

  it('keeps the ingest-only delay for agents that read a VT stream', async () => {
    vi.useFakeTimers()
    const raw = vi.fn((_id: string, _data: string) => true)
    const writer = new RuntimeTerminalWriter(
      raw,
      () => 'win32',
      () => 'claude'
    )
    const text = 'm'.repeat(2_015)
    const pending = writer.writeAction('pty', { text, enter: true }, `${text}\r`, {
      inputKind: 'driving'
    })
    await vi.advanceTimersByTimeAsync(1_000)
    await pending
    expect(raw.mock.calls.map((call) => call[1])).toEqual([text, '\r'])
  })

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

  it('does not submit when the send is cancelled during the burst wait', async () => {
    vi.useFakeTimers()
    const raw = vi.fn((_id: string, _data: string) => true)
    const controller = new AbortController()
    const writer = new RuntimeTerminalWriter(
      raw,
      () => 'win32',
      () => 'codex'
    )
    const text = 'm'.repeat(2_015)
    const pending = writer.writeAction('pty', { text, enter: true }, `${text}\r`, {
      inputKind: 'driving',
      signal: controller.signal
    })
    const rejected = expect(pending).rejects.toThrow('request_aborted')
    await vi.advanceTimersByTimeAsync(3_000)
    controller.abort()
    await rejected
    expect(raw.mock.calls.map((call) => call[1])).toEqual([text])
  })
})
