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
