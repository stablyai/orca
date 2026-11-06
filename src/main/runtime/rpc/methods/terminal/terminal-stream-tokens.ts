import { randomUUID } from 'node:crypto'

type TerminalStreamTokenEntry = {
  deviceId: string | undefined
  acknowledgeOutput: (units: number) => void
}

// Why tokens: relays renumber streamId, and a late ack keyed by terminal+client would credit its successor.
const liveStreams = new Map<string, TerminalStreamTokenEntry>()

export function registerTerminalStreamToken(
  deviceId: string | undefined,
  acknowledgeOutput: (units: number) => void
): { token: string; release: () => void } {
  const token = randomUUID()
  liveStreams.set(token, { deviceId, acknowledgeOutput })
  return { token, release: () => liveStreams.delete(token) }
}

export function acknowledgeTerminalStreamOutput(
  token: string,
  deviceId: string | undefined,
  units: number
): boolean {
  const entry = liveStreams.get(token)
  if (!entry || entry.deviceId !== deviceId) {
    return false
  }
  entry.acknowledgeOutput(units)
  return true
}
