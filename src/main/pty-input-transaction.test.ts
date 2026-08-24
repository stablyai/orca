import { describe, expect, it, vi } from 'vitest'
import { PtyInputTransactionOwner, type PtyInputWriteResult } from './pty-input-transaction'

const START = '\x1b[200~'
const END = '\x1b[201~'

describe('PTY input transaction owner', () => {
  it('keeps the unowned per-keystroke path as one direct provider write', () => {
    const writer = vi.fn(() => true)
    const owner = new PtyInputTransactionOwner(writer)

    expect(owner.write('pty-1', 'a')).toBe(true)
    expect(writer).toHaveBeenCalledOnce()
    expect(writer).toHaveBeenCalledWith('pty-1', 'a')
  })

  it('defers interactive admission until its first write', async () => {
    const writer = vi.fn(() => true)
    const owner = new PtyInputTransactionOwner(writer)
    const prompt = owner.begin('pty-1', 1, 'agent-prompt')!
    prompt.write(`${START}prompt`)

    const interactive = owner.begin('pty-1', 1, 'interactive')!
    expect(prompt.active).toBe(true)
    expect(writer).toHaveBeenCalledTimes(1)

    expect(interactive.write('manual')).toBe(true)
    expect(prompt.active).toBe(false)
    expect(prompt.invalidationReason).toBe('terminal_input_superseded')
    await expect(prompt.invalidated).resolves.toBe('terminal_input_superseded')
    expect(writer.mock.calls).toEqual([
      ['pty-1', `${START}prompt`],
      ['pty-1', END],
      ['pty-1', 'manual']
    ])
  })

  it('uses provider settlement and exposes lifecycle invalidation synchronously', async () => {
    let settle!: (accepted: boolean) => void
    const settledWriter = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          settle = resolve
        })
    )
    const owner = new PtyInputTransactionOwner(
      vi.fn(() => true),
      settledWriter
    )
    const prompt = owner.begin('pty-1', 1, 'agent-prompt')!

    const write = prompt.write('prompt')
    expect(settledWriter).toHaveBeenCalledWith('pty-1', 'prompt')
    owner.acknowledgeGeneration('pty-1', 2)
    expect(prompt.active).toBe(false)
    expect(prompt.invalidationReason).toBe('terminal_handle_stale')
    settle(true)

    await expect(write).resolves.toBe(true)
    await expect(prompt.invalidated).resolves.toBe('terminal_handle_stale')
  })

  it('updates framing before reentrant replies and rolls it back on rejection', async () => {
    const writes: string[] = []
    let owner!: PtyInputTransactionOwner
    const settledWriter = vi.fn((_ptyId: string, data: string): PtyInputWriteResult => {
      writes.push(data)
      if (data === `${START}prompt`) {
        expect(owner.write('pty-1', '\x1b[?0u')).toBe(true)
        return false
      }
      return true
    })
    const directWriter = vi.fn((_ptyId: string, data: string) => {
      writes.push(data)
      return true
    })
    owner = new PtyInputTransactionOwner(directWriter, settledWriter)
    const prompt = owner.begin('pty-1', 1, 'agent-prompt')!

    expect(prompt.write(`${START}prompt`)).toBe(false)
    expect(writes).toEqual([`${START}prompt`, '\x1b[?0u'])
    expect(owner.write('pty-1', 'manual')).toBe(true)
    await expect(prompt.invalidated).resolves.toBe('terminal_input_superseded')
    expect(writes).toEqual([`${START}prompt`, '\x1b[?0u', 'manual'])
  })

  it('retains a reentrant reply when paste close is rejected', async () => {
    const writes: string[] = []
    let owner!: PtyInputTransactionOwner
    let rejectClose = true
    const settledWriter = vi.fn((_ptyId: string, data: string): PtyInputWriteResult => {
      writes.push(data)
      if (data === END && rejectClose) {
        expect(owner.write('pty-1', '\x1b[6n')).toBe(true)
        return false
      }
      return true
    })
    owner = new PtyInputTransactionOwner((_ptyId, data) => {
      writes.push(data)
      return true
    }, settledWriter)
    const prompt = owner.begin('pty-1', 1, 'agent-prompt')!
    expect(prompt.write(`${START}prompt`)).toBe(true)

    expect(prompt.write(END)).toBe(false)
    expect(writes).toEqual([`${START}prompt`, END])
    rejectClose = false
    expect(owner.write('pty-1', 'manual')).toBe(true)
    await expect(prompt.invalidated).resolves.toBe('terminal_input_superseded')
    expect(writes).toEqual([`${START}prompt`, END, END, '\x1b[6n', 'manual'])
  })

  it('blocks manual input when closing an open paste is rejected', () => {
    const writes: string[] = []
    const writer = (_ptyId: string, data: string): boolean => {
      writes.push(data)
      return data !== END
    }
    const owner = new PtyInputTransactionOwner(writer, writer)
    const prompt = owner.begin('pty-1', 1, 'agent-prompt')!
    expect(prompt.write(`${START}prompt`)).toBe(true)

    expect(owner.write('pty-1', 'manual')).toBe(false)
    expect(prompt.active).toBe(true)
    expect(writes).toEqual([`${START}prompt`, END])
  })

  it('closes and preempts instead of dropping a query reply on queue overflow', async () => {
    const writes: string[] = []
    const owner = new PtyInputTransactionOwner((_ptyId, data) => {
      writes.push(data)
      return true
    })
    const prompt = owner.begin('pty-1', 1, 'agent-prompt')!
    prompt.write(`${START}prompt`)
    const replies = Array.from({ length: 65 }, (_, index) => `\x1b[${index + 1};1R`)

    for (const reply of replies) {
      expect(owner.write('pty-1', reply)).toBe(true)
    }

    await expect(prompt.invalidated).resolves.toBe('terminal_input_superseded')
    expect(writes).toEqual([`${START}prompt`, END, ...replies])
  })

  it('gives external input priority over an automation transaction', async () => {
    const writer = vi.fn(() => true)
    const owner = new PtyInputTransactionOwner(writer)
    const automation = owner.begin('pty-1', 1, 'automation')!

    expect(owner.write('pty-1', 'manual')).toBe(true)
    expect(automation.active).toBe(false)
    await expect(automation.invalidated).resolves.toBe('terminal_input_superseded')
    expect(automation.write('stale')).toBe(false)
  })

  it('owns paste framing for automation and closes it before external input', async () => {
    const writes: string[] = []
    const owner = new PtyInputTransactionOwner((_ptyId, data) => {
      writes.push(data)
      return true
    })
    const automation = owner.begin('pty-1', 1, 'automation')!
    expect(automation.write(`${START}draft`)).toBe(true)
    expect(owner.write('pty-1', 'manual')).toBe(true)

    await expect(automation.invalidated).resolves.toBe('terminal_input_superseded')
    expect(writes).toEqual([`${START}draft`, END, 'manual'])
  })

  it('retains released paste framing until it can be closed', () => {
    const writes: string[] = []
    let rejectClose = true
    const owner = new PtyInputTransactionOwner((_ptyId, data) => {
      writes.push(data)
      return data !== END || !rejectClose
    })
    const automation = owner.begin('pty-1', 1, 'automation')!
    expect(automation.write(`${START}draft`)).toBe(true)
    automation.release()

    expect(owner.write('pty-1', 'first')).toBe(false)
    rejectClose = false
    expect(owner.write('pty-1', 'second')).toBe(true)
    expect(writes).toEqual([`${START}draft`, END, END, 'second'])
  })

  it('lets unversioned renderer input safely preempt a versioned prompt', async () => {
    const writes: string[] = []
    const owner = new PtyInputTransactionOwner((_ptyId, data) => {
      writes.push(data)
      return true
    })
    const prompt = owner.begin('pty-1', 7, 'agent-prompt')!
    expect(prompt.write(`${START}prompt`)).toBe(true)
    const renderer = owner.beginUnversionedInteractive('pty-1')

    expect(renderer.write('manual-1')).toBe(true)
    expect(renderer.write('manual-2')).toBe(true)

    await expect(prompt.invalidated).resolves.toBe('terminal_input_superseded')
    expect(writes).toEqual([`${START}prompt`, END, 'manual-1', 'manual-2'])
  })

  it('does not let internal automation preempt a prompt', () => {
    const owner = new PtyInputTransactionOwner(() => true)
    const prompt = owner.begin('pty-1', 1, 'agent-prompt')!

    expect(owner.begin('pty-1', 1, 'automation')).toBeNull()
    expect(prompt.active).toBe(true)
  })

  it('rejects a concurrent direct client while a renderer transaction owns the PTY', () => {
    const writer = vi.fn(() => true)
    const owner = new PtyInputTransactionOwner(writer)
    const renderer = owner.beginUnversionedInteractive('pty-1')

    expect(renderer.write('first chunk')).toBe(true)
    expect(owner.write('pty-1', 'concurrent client')).toBe(false)
    expect(writer).toHaveBeenCalledOnce()
  })

  it('queues terminal query replies behind an interactive paste transaction', () => {
    const writes: string[] = []
    const owner = new PtyInputTransactionOwner((_ptyId, data) => {
      writes.push(data)
      return true
    })
    const renderer = owner.beginUnversionedInteractive('pty-1')

    expect(renderer.write(`${START}chunk`)).toBe(true)
    expect(owner.write('pty-1', '\x1b[6n')).toBe(true)
    expect(owner.write('pty-1', 'concurrent client')).toBe(false)
    expect(renderer.write(END)).toBe(true)
    renderer.release()

    expect(writes).toEqual([`${START}chunk`, END, '\x1b[6n'])
  })

  it('retries a deferred query reply before admitting a replacement transaction', () => {
    let failReply = true
    const writer = vi.fn((_ptyId: string, data: string) => {
      if (data === '\x1b[6n' && failReply) {
        return false
      }
      return true
    })
    const owner = new PtyInputTransactionOwner(writer)
    const prompt = owner.begin('pty-1', 1, 'agent-prompt')!
    expect(prompt.write(`${START}prompt`)).toBe(true)
    expect(owner.write('pty-1', '\x1b[6n')).toBe(true)
    expect(prompt.write(END)).toBe(true)
    prompt.release()

    failReply = false
    const replacement = owner.begin('pty-1', 1, 'agent-prompt')
    expect(replacement).not.toBeNull()
    expect(writer.mock.calls).toEqual([
      ['pty-1', `${START}prompt`],
      ['pty-1', END],
      ['pty-1', '\x1b[6n'],
      ['pty-1', '\x1b[6n'],
      ['pty-1', '\x1b[6n']
    ])
  })

  it('keeps a newly arrived query reply behind a deferred reply', () => {
    let failReply = true
    const writes: string[] = []
    const owner = new PtyInputTransactionOwner((_ptyId, data) => {
      writes.push(data)
      return !failReply || data !== '\x1b[6n'
    })
    const prompt = owner.begin('pty-1', 1, 'agent-prompt')!
    prompt.write(`${START}prompt`)
    owner.write('pty-1', '\x1b[6n')
    prompt.write(END)
    prompt.release()
    expect(owner.write('pty-1', '\x1b[5n')).toBe(true)
    failReply = false
    expect(owner.begin('pty-1', 1, 'agent-prompt')).not.toBeNull()
    expect(writes.slice(-2)).toEqual(['\x1b[6n', '\x1b[5n'])
  })

  it('joins interactive transactions only when each attempts a write', () => {
    const owner = new PtyInputTransactionOwner(() => true)
    const first = owner.begin('pty-1', 1, 'interactive')!
    const second = owner.begin('pty-1', 1, 'interactive')!

    expect(first.write('a')).toBe(true)
    expect(second.write('b')).toBe(true)
    first.release()
    expect(second.write('c')).toBe(true)
  })

  it('invalidates lazy and admitted transactions on lifecycle acknowledgement', async () => {
    const owner = new PtyInputTransactionOwner(() => true)
    const lazy = owner.begin('pty-1', 1, 'interactive')!
    const prompt = owner.begin('pty-2', 1, 'agent-prompt')!

    owner.acknowledgeGeneration('pty-1', 2)
    owner.acknowledgeGeneration('pty-2', 2)

    expect(lazy.active).toBe(false)
    expect(prompt.active).toBe(false)
    await expect(lazy.invalidated).resolves.toBe('terminal_handle_stale')
    await expect(prompt.invalidated).resolves.toBe('terminal_handle_stale')
    expect(lazy.write('stale')).toBe(false)
    expect(prompt.write('stale')).toBe(false)
  })

  it('invalidates an older lazy writer before a newer generation claims the PTY', async () => {
    const owner = new PtyInputTransactionOwner(() => true)
    const stale = owner.begin('pty-1', 1, 'interactive')!
    const current = owner.begin('pty-1', 2, 'interactive')!

    await expect(stale.invalidated).resolves.toBe('terminal_handle_stale')
    expect(stale.write('stale')).toBe(false)
    expect(current.write('current')).toBe(true)
  })

  it('does not let a stale release clear a newer transaction', () => {
    const owner = new PtyInputTransactionOwner(() => true)
    const first = owner.begin('pty-1', 1, 'automation')!
    owner.acknowledgeGeneration('pty-1', 2)
    const second = owner.begin('pty-1', 2, 'automation')!

    first.release()

    expect(first.write('stale')).toBe(false)
    expect(second.write('current')).toBe(true)
  })

  it('isolates ownership by PTY id', () => {
    const owner = new PtyInputTransactionOwner(() => true)
    const transaction = owner.begin('pty-1', 1, 'agent-prompt')!

    expect(owner.write('pty-2', 'manual')).toBe(true)
    expect(owner.begin('pty-2', 1, 'automation')).not.toBeNull()
    transaction.release()
  })
})
