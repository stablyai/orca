import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { scanCodexLeaseProcesses } from './codex-shared-lease-process-scan'

const ENV = 'ORCA_CODEX_SHARED_LEASE'
const children: ChildProcess[] = []

afterEach(() => {
  for (const child of children.splice(0)) {
    child.kill('SIGKILL')
  }
})

function sleeper(env: Record<string, string>, args: string[] = []): ChildProcess {
  const child = spawn('/bin/sh', ['-c', 'sleep 30', ...args], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
    stdio: 'ignore'
  })
  children.push(child)
  return child
}

// macOS hides Apple binaries' environments and scans only under the server, so the real-process
// check runs where every own-user process is readable.
describe.skipIf(process.platform !== 'linux')('shared Codex lease process scan', () => {
  it('finds a process by the lease tag in its environment, never by the same text in its arguments', async () => {
    const lease = `lease-${process.pid}-${Date.now()}`
    const owned = sleeper({ [ENV]: lease })
    const decoy = sleeper({ [ENV]: 'someone-else' }, [`${ENV}=${lease}`])
    await new Promise((resolve) => setTimeout(resolve, 300))
    const scan = await scanCodexLeaseProcesses(ENV, process.pid)
    expect(scan).not.toBeNull()
    const tagged = scan!.tagged(lease)
    expect(tagged).toContain(owned.pid)
    expect(tagged).not.toContain(decoy.pid)
  })
})
