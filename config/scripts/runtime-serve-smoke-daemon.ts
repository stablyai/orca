import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { DaemonClient } from '../../src/main/daemon/client'
import { getDaemonSocketPath, getDaemonTokenPath } from '../../src/main/daemon/daemon-spawner'

/** Retire only the daemon authenticated by this smoke test's disposable profile. */
async function main(): Promise<void> {
  const userData = process.argv[2]
  if (!userData) {
    throw new Error('A disposable profile directory is required')
  }
  const runtimeDir = join(userData, 'daemon')
  const tokenPath = getDaemonTokenPath(runtimeDir)
  if (!existsSync(tokenPath)) {
    return
  }
  const client = new DaemonClient({ socketPath: getDaemonSocketPath(runtimeDir), tokenPath })
  try {
    await client.ensureConnectedWithin(2_000)
    const identity = client.getDaemonIdentity()
    if (!identity) {
      throw new Error('Smoke daemon did not report its identity')
    }
    // Shutdown may close the transport before its reply; process exit is the verdict.
    await client.request('shutdown', { killSessions: true }, 2_000).catch(() => undefined)
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      try {
        process.kill(identity.pid, 0)
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
          return
        }
        throw error
      }
      await delay(50)
    }
    throw new Error('Smoke daemon survived its shutdown request')
  } finally {
    client.disconnect()
  }
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
