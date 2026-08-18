import { once } from 'node:events'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { createDeterministicGzipStore } from './skill-package-deterministic-gzip'

async function encode(chunks: readonly Buffer[]): Promise<Buffer> {
  const encoder = createDeterministicGzipStore()
  const output: Buffer[] = []
  encoder.on('data', (chunk: Buffer) => output.push(chunk))
  for (const chunk of chunks) {
    encoder.write(chunk)
  }
  encoder.end()
  await once(encoder, 'end')
  return Buffer.concat(output)
}

describe('deterministic skill package gzip', () => {
  it('is independent of input chunking and readable by standard gzip', async () => {
    const input = Buffer.alloc(65_535 * 2 + 17)
    for (let index = 0; index < input.length; index += 1) {
      input[index] = index % 251
    }
    const whole = await encode([input])
    const chunked = await encode([
      input.subarray(0, 7),
      input.subarray(7, 70_000),
      input.subarray(70_000)
    ])

    expect(chunked).toEqual(whole)
    expect(gunzipSync(whole)).toEqual(input)
    expect(whole.subarray(0, 10)).toEqual(Buffer.from([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 0xff]))
  })

  it('emits a valid empty gzip stream', async () => {
    expect(gunzipSync(await encode([]))).toEqual(Buffer.alloc(0))
  })
})
