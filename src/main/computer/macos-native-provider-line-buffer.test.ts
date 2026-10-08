import { describe, expect, it } from 'vitest'
import { NativeProviderLineBuffer } from './macos-native-provider-transport'

describe('NativeProviderLineBuffer', () => {
  it('keeps partial lines and original whitespace while omitting blank lines', () => {
    const buffer = new NativeProviderLineBuffer()
    const lines: string[] = []
    const record = (line: string): void => {
      lines.push(line)
    }
    buffer.push(' \t\r\n  first\r\nsecond', record)
    expect(lines).toEqual(['  first\r'])
    buffer.push(' half\n\nthird\npartial', record)
    expect(lines).toEqual(['  first\r', 'second half', 'third'])
    buffer.push('', record)
    buffer.push(' tail\n', record)
    expect(lines).toEqual(['  first\r', 'second half', 'third', 'partial tail'])
  })

  it('preserves split surrogate pairs and lone surrogate code units', () => {
    const buffer = new NativeProviderLineBuffer()
    const lines: string[] = []
    for (const chunk of ['\ud83d', '\ude00\n\ud83d', '\n\udc00', '\n']) {
      buffer.push(chunk, (line) => {
        lines.push(line)
      })
    }
    expect(lines).toEqual(['😀', '\ud83d', '\udc00'])
  })

  it.each(['', 'suffix'])('retries all complete lines after callback failure on %j', (suffix) => {
    const buffer = new NativeProviderLineBuffer()
    const lines: string[] = []
    expect(() =>
      buffer.push('first\nsecond\npartial', (line) => {
        lines.push(line)
        if (line === 'second') {
          throw new Error('callback failure')
        }
      })
    ).toThrow('callback failure')
    buffer.push(suffix, (line) => {
      lines.push(line)
    })
    buffer.push('\n', (line) => {
      lines.push(line)
    })
    expect(lines).toEqual(['first', 'second', 'first', 'second', `partial${suffix}`])
  })

  it('clears both partial and callback-failed buffers', () => {
    const buffer = new NativeProviderLineBuffer()
    buffer.push('old partial', () => {
      throw new Error('unexpected line')
    })
    buffer.clear()
    expect(() =>
      buffer.push('failed\n', () => {
        throw new Error('callback failure')
      })
    ).toThrow()
    buffer.clear()
    const lines: string[] = []
    buffer.push('new', (line) => {
      lines.push(line)
    })
    expect(lines).toEqual([])
    buffer.push('\n', (line) => {
      lines.push(line)
    })
    expect(lines).toEqual(['new'])
  })

  it('preserves reentrant feed ordering and the outer call remainder', () => {
    const buffer = new NativeProviderLineBuffer()
    const lines: string[] = []
    let reentered = false
    const record = (line: string): void => {
      lines.push(line)
      if (!reentered) {
        reentered = true
        buffer.push('extra\n', record)
      }
    }
    buffer.push('first\nsecond\npartial', record)
    buffer.push('\n', record)
    expect(lines).toEqual(['first', 'first', 'second', 'partialextra', 'second', 'partial'])
  })

  it('preserves a reentrant clear and partial feed when the outer callback throws', () => {
    const buffer = new NativeProviderLineBuffer()
    const lines: string[] = []
    const record = (line: string): void => {
      lines.push(line)
    }
    expect(() =>
      buffer.push('old\npartial', () => {
        buffer.clear()
        buffer.push('new', record)
        throw new Error('callback failure')
      })
    ).toThrow('callback failure')
    buffer.push(' tail', record)
    expect(lines).toEqual([])
    buffer.push('\n', record)
    expect(lines).toEqual(['new tail'])
  })
})
