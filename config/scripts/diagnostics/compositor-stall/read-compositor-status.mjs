import { open } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

const profile = process.argv[2]
if (!profile || !isAbsolute(profile)) {
  throw new Error('Provide the absolute user-data directory of the local diagnostic build.')
}

let output = {
  state: 'off',
  lastResult: null,
  coverageLimits: null,
  disabledForSessionReason: null
}
let handle
try {
  handle = await open(join(profile, 'compositor-diagnostics', 'observations.ndjson'), 'r')
  const stat = await handle.stat()
  const buffer = Buffer.alloc(Math.min(stat.size, 64 * 1024))
  await handle.read(buffer, 0, buffer.length, Math.max(0, stat.size - buffer.length))
  const lines = buffer.toString('utf8').split('\n')
  const last = lines.at(-2)
  if (last) {
    const record = JSON.parse(last)
    if (record.version === 1) {
      output = {
        state: Date.now() - record.time > 600_000 ? 'stale' : record.state,
        lastResult: record.lastResult,
        coverageLimits: record.coverageLimits,
        disabledForSessionReason: record.disabledForSessionReason
      }
    }
  }
} catch (error) {
  if (error.code !== 'ENOENT') {
    output = { ...output, state: 'unavailable' }
  }
} finally {
  await handle?.close()
}
process.stdout.write(`${JSON.stringify(output)}\n`)
