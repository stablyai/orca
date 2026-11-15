import { describe, expect, it } from 'vitest'
import { readOpenAiKeyFromStdin } from './speech'

async function* chunks(...parts: string[]): AsyncGenerator<Buffer> {
  for (const part of parts) {
    yield Buffer.from(part)
  }
}

function piped(...parts: string[]): AsyncIterable<unknown> & { isTTY?: boolean } {
  return chunks(...parts)
}

describe('orca speech openai-key set', () => {
  it('reads the key from piped stdin and trims the trailing newline', async () => {
    await expect(readOpenAiKeyFromStdin(piped('sk-test-', 'abc\n'))).resolves.toBe('sk-test-abc')
  })

  it('refuses an interactive terminal instead of waiting on it', async () => {
    const terminal = Object.assign(chunks(), { isTTY: true })
    await expect(readOpenAiKeyFromStdin(terminal)).rejects.toThrow('Pipe the key on stdin')
  })

  it('refuses empty and oversized input', async () => {
    await expect(readOpenAiKeyFromStdin(piped('  \n'))).rejects.toThrow('No key on stdin')
    await expect(readOpenAiKeyFromStdin(piped('x'.repeat(1025)))).rejects.toThrow('too long')
  })
})
