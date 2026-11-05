export async function websocketPayloadToUint8(value: unknown): Promise<Uint8Array | null> {
  if (value instanceof Uint8Array) {
    return value
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value)
  }
  if (value && typeof value === 'object' && 'arrayBuffer' in value) {
    const blob = value as { arrayBuffer: () => Promise<ArrayBuffer> }
    try {
      return new Uint8Array(await blob.arrayBuffer())
    } catch {
      return null
    }
  }
  if (typeof FileReader !== 'undefined' && value instanceof Blob) {
    return new Promise((resolve) => {
      const reader = new FileReader()
      reader.onload = () => {
        resolve(reader.result instanceof ArrayBuffer ? new Uint8Array(reader.result) : null)
      }
      reader.onerror = () => resolve(null)
      reader.readAsArrayBuffer(value)
    })
  }
  return null
}
