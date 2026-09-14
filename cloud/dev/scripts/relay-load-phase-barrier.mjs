import { access, mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delayDefault } from 'node:timers/promises'

export async function waitForRelayLoadPhaseBarrier(config, overrides = {}) {
  const delay = overrides.delay ?? delayDefault
  const now = overrides.now ?? Date.now
  const timeoutMs = overrides.timeoutMs ?? config.timeoutMs
  if (
    typeof config.directory !== 'string' || config.directory.length === 0 ||
    !Number.isSafeInteger(config.shardCount) || config.shardCount < 2 ||
    !Number.isSafeInteger(config.shardIndex) || config.shardIndex < 0 ||
    config.shardIndex >= config.shardCount ||
    !Number.isSafeInteger(timeoutMs) || timeoutMs < 1
  ) throw new Error('invalid Relay load phase barrier')

  await mkdir(config.directory, { recursive: true })
  const marker = join(config.directory, `${config.shardIndex}.ready`)
  const handle = await open(marker, 'wx')
  await handle.close()
  const deadline = now() + timeoutMs
  for (;;) {
    const ready = await Promise.all(
      Array.from({ length: config.shardCount }, async (_, index) => {
        try {
          await access(join(config.directory, `${index}.ready`))
          return true
        } catch {
          return false
        }
      })
    )
    if (ready.every(Boolean)) return
    if (now() >= deadline) throw new Error('Relay load phase barrier timed out')
    await delay(100)
  }
}
