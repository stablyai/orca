export function resampleToRate(
  samples: Float32Array,
  inputSampleRate: number,
  outputSampleRate: number
): Float32Array {
  if (
    samples.length === 0 ||
    !Number.isFinite(inputSampleRate) ||
    !Number.isFinite(outputSampleRate) ||
    inputSampleRate <= 0 ||
    outputSampleRate <= 0 ||
    inputSampleRate === outputSampleRate
  ) {
    return samples
  }

  const outputLength = Math.max(
    1,
    Math.round((samples.length * outputSampleRate) / inputSampleRate)
  )
  const output = new Float32Array(outputLength)
  const ratio = inputSampleRate / outputSampleRate
  for (let i = 0; i < outputLength; i += 1) {
    const sourceIndex = i * ratio
    const left = Math.floor(sourceIndex)
    const right = Math.min(left + 1, samples.length - 1)
    const weight = sourceIndex - left
    output[i] = samples[left] * (1 - weight) + samples[right] * weight
  }
  return output
}

/**
 * Linear resampler for a chunked stream: it carries the last input sample and the
 * fractional read position across chunks, so chunk boundaries neither drop nor repeat audio.
 */
export class StreamingLinearResampler {
  private inputSampleRate = 0
  private previousSample = 0
  // Source index of the next output sample; -1 means the carried previous sample.
  private position = 0

  constructor(private readonly outputSampleRate: number) {}

  push(samples: Float32Array, inputSampleRate: number): Float32Array {
    if (inputSampleRate !== this.inputSampleRate) {
      // Why: a device switch changes the rate, and the old phase means nothing at the new one.
      this.inputSampleRate = inputSampleRate
      this.reset()
    }
    if (inputSampleRate === this.outputSampleRate || samples.length === 0) {
      return samples
    }
    const ratio = inputSampleRate / this.outputSampleRate
    const lastIndex = samples.length - 1
    // Why: one spare slot absorbs float rounding so the loop never stops short of lastIndex.
    const capacity = Math.max(0, Math.ceil((lastIndex - this.position) / ratio)) + 1
    const output = new Float32Array(capacity)
    let written = 0
    // Why: an output whose right neighbour is not here yet waits for the next chunk.
    while (this.position < lastIndex) {
      const left = Math.floor(this.position)
      const weight = this.position - left
      const leftSample = left < 0 ? this.previousSample : samples[left]
      output[written] = leftSample * (1 - weight) + samples[left + 1] * weight
      written += 1
      this.position += ratio
    }
    this.position -= samples.length
    this.previousSample = samples[lastIndex]
    return output.subarray(0, written)
  }

  reset(): void {
    this.previousSample = 0
    this.position = 0
  }
}
