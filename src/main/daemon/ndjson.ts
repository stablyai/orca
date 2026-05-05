export function encodeNdjson(msg: unknown): string {
  return `${JSON.stringify(msg)}\n`
}

export type NdjsonParser = {
  feed(chunk: string): void
  reset(): void
}

export function createNdjsonParser(
  onMessage: (msg: unknown) => void,
  onError?: (err: Error) => void
): NdjsonParser {
  let buffer = ''

  return {
    feed(chunk: string): void {
      buffer += chunk

      let newlineIndex: number
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex)
        buffer = buffer.slice(newlineIndex + 1)

        if (line.length === 0) {
          continue
        }

        try {
          onMessage(JSON.parse(line))
        } catch (err) {
          onError?.(err instanceof Error ? err : new Error(String(err)))
        }
      }
    },

    reset(): void {
      buffer = ''
    }
  }
}
