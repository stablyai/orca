export function encodePcm16Le(samples: Float32Array): Buffer {
  const buffer = Buffer.allocUnsafe(samples.length * 2)
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]))
    const value = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
    buffer.writeInt16LE(Math.round(value), index * 2)
  }
  return buffer
}
