import { PassThrough, Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TERMINAL_INPUT_MAX_BYTES } from '../shared/terminal-input'
import {
  getComputerSetValueActionFlags,
  getComputerTextActionFlags
} from './handlers/computer-action-flags'
import { readStdinPayload } from './stdin-payload'

const stdin = process.stdin
const ttyDescriptor = Object.getOwnPropertyDescriptor(stdin, 'isTTY')
let source: Readable

beforeEach(() => {
  source = Readable.from([])
  Object.defineProperty(stdin, 'isTTY', { configurable: true, value: false })
  vi.spyOn(stdin, Symbol.asyncIterator).mockImplementation(() => source[Symbol.asyncIterator]())
})

afterEach(() => {
  source.destroy()
  vi.restoreAllMocks()
  if (ttyDescriptor) {
    Object.defineProperty(stdin, 'isTTY', ttyDescriptor)
  } else {
    Reflect.deleteProperty(stdin, 'isTTY')
  }
})

describe('stdin payload reader', () => {
  it('decodes only after joining Buffer chunks, preserving split UTF-8 and text syntax', async () => {
    const text = '"quoted" \'single\' `literal` $HOME $(literal)\r\n/compact C:\\notes é 😀\n'
    const bytes = Buffer.from(text)
    source = Readable.from(Array.from(bytes, (byte) => Buffer.from([byte])))

    expect(await readStdinPayload()).toBe(text)
  })

  it('waits for EOF from a finite pipe and preserves CRLF and a trailing newline', async () => {
    const pipe = new PassThrough()
    source = pipe
    let completed = false
    const pending = readStdinPayload().then((text) => {
      completed = true
      return text
    })
    pipe.write(Buffer.from('first\r\n'))
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(completed).toBe(false)
    pipe.end(Buffer.from('last\n'))

    expect(await pending).toBe('first\r\nlast\n')
  })

  it('accepts string chunks and measures their UTF-8 bytes', async () => {
    source = Readable.from(['é', '😀'])
    expect(await readStdinPayload(6)).toBe('é😀')
  })

  it('keeps the existing malformed UTF-8 replacement behavior', async () => {
    source = Readable.from([Buffer.from([0xff]), Buffer.from('ok')])
    expect(await readStdinPayload()).toBe('\uFFFDok')
  })

  it('accepts empty stdin, including a zero-byte bound', async () => {
    expect(await readStdinPayload(0)).toBe('')
  })

  it('refuses a TTY without consuming input', async () => {
    Object.defineProperty(stdin, 'isTTY', { configurable: true, value: true })
    await expect(readStdinPayload()).rejects.toMatchObject({
      code: 'invalid_argument',
      message: 'stdin payload requested but stdin is a TTY'
    })
    expect(stdin[Symbol.asyncIterator]).not.toHaveBeenCalled()
  })

  it('propagates a stream read failure', async () => {
    const pipe = new PassThrough()
    source = pipe
    const error = new Error('owned pipe failed')
    const pending = readStdinPayload()
    pipe.destroy(error)
    await expect(pending).rejects.toBe(error)
  })

  it('accepts the exact terminal byte budget without truncation', async () => {
    source = Readable.from([Buffer.alloc(TERMINAL_INPUT_MAX_BYTES - 4, 'x'), Buffer.from('😀')])
    const text = await readStdinPayload(TERMINAL_INPUT_MAX_BYTES)
    expect(Buffer.byteLength(text)).toBe(TERMINAL_INPUT_MAX_BYTES)
    expect(text.endsWith('😀')).toBe(true)
  })

  it('rejects one raw byte over budget before joining retained chunks', async () => {
    source = Readable.from([Buffer.alloc(TERMINAL_INPUT_MAX_BYTES, 'x'), Buffer.from('y')])
    const concat = vi.spyOn(Buffer, 'concat')
    await expect(readStdinPayload(TERMINAL_INPUT_MAX_BYTES)).rejects.toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining(`${TERMINAL_INPUT_MAX_BYTES}-byte`)
    })
    expect(concat).not.toHaveBeenCalled()
  })

  it('rejects a multibyte string by bytes rather than characters', async () => {
    source = Readable.from(['é'])
    await expect(readStdinPayload(1)).rejects.toMatchObject({ code: 'invalid_argument' })
  })

  it('leaves existing unbounded computer-reader behavior unchanged by default', async () => {
    source = Readable.from([Buffer.alloc(TERMINAL_INPUT_MAX_BYTES + 1, 'x')])
    expect((await readStdinPayload()).length).toBe(TERMINAL_INPUT_MAX_BYTES + 1)
  })
})

describe('computer callers of the shared reader', () => {
  it('keeps empty type/paste-text stdin invalid', async () => {
    await expect(getComputerTextActionFlags(new Map([['text-stdin', true]]))).rejects.toMatchObject(
      {
        code: 'invalid_argument',
        message: 'Missing text from stdin'
      }
    )
  })

  it('keeps empty set-value stdin valid', async () => {
    const flags = new Map<string, string | boolean>([
      ['element-index', '0'],
      ['value-stdin', true]
    ])
    expect(await getComputerSetValueActionFlags(flags)).toEqual({ elementIndex: 0, value: '' })
  })

  it.each(['text', 'value'] as const)('keeps --%s-stdin TTY refusal', async (name) => {
    Object.defineProperty(stdin, 'isTTY', { configurable: true, value: true })
    const flags = new Map<string, string | boolean>([
      ['element-index', '0'],
      [`${name}-stdin`, true]
    ])
    const pending =
      name === 'text' ? getComputerTextActionFlags(flags) : getComputerSetValueActionFlags(flags)
    await expect(pending).rejects.toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('TTY')
    })
    expect(stdin[Symbol.asyncIterator]).not.toHaveBeenCalled()
  })

  it.each(['text', 'value'] as const)(
    'keeps empty argv --%s exclusive with stdin',
    async (name) => {
      const flags = new Map<string, string | boolean>([
        ['element-index', '0'],
        [name, ''],
        [`${name}-stdin`, true]
      ])
      const pending =
        name === 'text' ? getComputerTextActionFlags(flags) : getComputerSetValueActionFlags(flags)
      await expect(pending).rejects.toMatchObject({ code: 'invalid_argument' })
      expect(stdin[Symbol.asyncIterator]).not.toHaveBeenCalled()
    }
  )
})
