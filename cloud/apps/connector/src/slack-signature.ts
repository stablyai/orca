import { createHmac, timingSafeEqual } from 'node:crypto'

const MAX_TIMESTAMP_SKEW_SECONDS = 5 * 60

// Slack's v0 scheme: HMAC-SHA256 over `v0:<timestamp>:<raw body>`, refused when the timestamp is
// more than five minutes from our clock (replay window).
export function verifySlackSignature(input: {
  signingSecret: string
  timestamp: string | undefined
  signature: string | undefined
  rawBody: string
  nowMs: number
}): boolean {
  const { timestamp, signature } = input
  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) {
    return false
  }
  if (Math.abs(input.nowMs / 1000 - Number(timestamp)) > MAX_TIMESTAMP_SKEW_SECONDS) {
    return false
  }
  const expected = Buffer.from(
    `v0=${createHmac('sha256', input.signingSecret).update(`v0:${timestamp}:${input.rawBody}`).digest('hex')}`
  )
  const received = Buffer.from(signature)
  return received.length === expected.length && timingSafeEqual(received, expected)
}
