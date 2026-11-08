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
  it('emits a valid empty gzip stream', async () => {
    expect(gunzipSync(await encode([]))).toEqual(Buffer.alloc(0))
  })
})
