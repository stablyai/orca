export type SonioxSocket = {
  readyState: number
  bufferedAmount?: number
  send(data: string | Buffer): void
  close(): void
  removeAllListeners(): unknown
  on(event: 'open', listener: () => void): unknown
  on(event: 'message', listener: (data: unknown, isBinary: boolean) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'close', listener: (code: number, reason: Buffer) => void): unknown
}
