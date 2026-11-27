import { describe, expect, it } from 'vitest'
import { spawnCommandCapture } from './spawn-command-capture'

// Write the first byte, then the rest 50 ms later, so the first character straddles two pipe reads.
const writeSplitChars = `
const split = (stream, text) => {
  const bytes = Buffer.from(text)
  stream.write(bytes.subarray(0, 1))
  setTimeout(() => stream.write(bytes.subarray(1)), 50)
}
split(process.stdout, 'é中😀')
split(process.stderr, 'ø界🚀')
`

describe('spawnCommandCapture', () => {
  it('decodes multibyte characters split across pipe reads', async () => {
    await expect(
      spawnCommandCapture(process.execPath, ['-e', writeSplitChars], { timeout: 5_000 })
    ).resolves.toEqual({ stdout: 'é中😀', stderr: 'ø界🚀' })
  })
})
