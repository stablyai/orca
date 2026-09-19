import { setTimeout as delay } from 'node:timers/promises'

export function hasOrcadLifecycleOutputLine(result, marker) {
  return (
    result?.terminal?.tail?.some((line) => typeof line === 'string' && line.trim() === marker) ===
    true
  )
}

export async function verifyOrcadLifecycleTerminalRoundTrip({
  marker,
  waitForWritable,
  send,
  read
}) {
  if (!/^ORCAD_BUN_LIFECYCLE_[a-zA-Z0-9_]+$/.test(marker)) {
    throw new Error('Invalid lifecycle output marker')
  }
  await waitForWritable()
  await send(`echo ${marker}`)
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (hasOrcadLifecycleOutputLine(await read(), marker)) {
      return
    }
    await delay(500)
  }
  throw new Error(`Terminal did not execute lifecycle probe: ${marker}`)
}
