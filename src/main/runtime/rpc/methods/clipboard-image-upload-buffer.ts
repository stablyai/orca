const BASE64_PADDING_BYTE = '='.charCodeAt(0)

function isBase64DataByte(byte: number): boolean {
  return (
    (byte >= 65 && byte <= 90) ||
    (byte >= 97 && byte <= 122) ||
    (byte >= 48 && byte <= 57) ||
    byte === 43 ||
    byte === 47
  )
}

export class ClipboardImageUploadBuffer {
  private readonly segments: Buffer[] = []
  private retainedLength = 0

  constructor(
    private readonly expectedLength: number,
    private readonly segmentLength: number
  ) {}

  get length(): number {
    return this.retainedLength
  }

  append(contentBase64: string): void {
    if (contentBase64.length > this.expectedLength - this.retainedLength) {
      throw new Error('Clipboard image upload exceeded expected size')
    }
    const source = Buffer.from(contentBase64, 'ascii')
    const originalLength = this.retainedLength
    const originalSegmentCount = this.segments.length
    let sourceOffset = 0
    try {
      while (sourceOffset < source.length) {
        const segmentIndex = Math.floor(this.retainedLength / this.segmentLength)
        const segmentOffset = this.retainedLength % this.segmentLength
        let segment = this.segments[segmentIndex]
        if (!segment) {
          const segmentStart = segmentIndex * this.segmentLength
          segment = Buffer.allocUnsafe(
            Math.min(this.segmentLength, this.expectedLength - segmentStart)
          )
          this.segments.push(segment)
        }
        const copyLength = Math.min(source.length - sourceOffset, segment.length - segmentOffset)
        source.copy(segment, segmentOffset, sourceOffset, sourceOffset + copyLength)
        sourceOffset += copyLength
        this.retainedLength += copyLength
      }
    } catch (error) {
      this.retainedLength = originalLength
      this.segments.length = originalSegmentCount
      throw error
    }
  }

  clear(): void {
    this.retainedLength = 0
    this.segments.length = 0
  }

  decode(): Buffer {
    const dataLength = this.validateAndGetDataLength()
    const decoded = Buffer.allocUnsafe(Math.floor((dataLength * 3) / 4))
    let carry = ''
    let remainingData = dataLength
    let written = 0
    for (const segment of this.segments) {
      if (remainingData === 0) {
        break
      }
      const segmentDataLength = Math.min(segment.length, remainingData)
      const data = segment.subarray(0, segmentDataLength).toString('ascii')
      const combined = carry.length > 0 ? carry + data : data
      const completeLength = combined.length - (combined.length % 4)
      if (completeLength > 0) {
        const complete =
          completeLength === combined.length ? combined : combined.slice(0, completeLength)
        written += decoded.write(complete, written, 'base64')
      }
      carry = completeLength === combined.length ? '' : combined.slice(completeLength)
      remainingData -= segmentDataLength
    }
    if (carry.length > 0) {
      written += decoded.write(carry, written, 'base64')
    }
    if (written !== decoded.length) {
      throw new Error('Clipboard image content must be base64')
    }
    return decoded
  }

  private validateAndGetDataLength(): number {
    if (this.retainedLength % 4 === 1) {
      throw new Error('Clipboard image content must be base64')
    }
    let dataLength = 0
    let paddingLength = 0
    let remaining = this.retainedLength
    for (const segment of this.segments) {
      const usedLength = Math.min(segment.length, remaining)
      for (let index = 0; index < usedLength; index++) {
        const byte = segment[index]
        if (byte === BASE64_PADDING_BYTE) {
          paddingLength += 1
          continue
        }
        if (paddingLength > 0 || !isBase64DataByte(byte)) {
          throw new Error('Clipboard image content must be base64')
        }
        dataLength += 1
      }
      remaining -= usedLength
    }
    if (paddingLength > 2) {
      throw new Error('Clipboard image content must be base64')
    }
    return dataLength
  }
}
