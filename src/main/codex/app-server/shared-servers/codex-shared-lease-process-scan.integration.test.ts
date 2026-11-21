import { spawn, type ChildProcess } from 'node:child_process'
import { chmod, copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanCodexLeaseProcesses } from './codex-shared-lease-process-scan'

const ENV = 'ORCA_CODEX_SHARED_LEASE'
const children: ChildProcess[] = []
const groups: number[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill('SIGKILL')
  }
  for (const group of groups.splice(0)) {
    try {
      process.kill(-group, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
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
    const tagged = async (): Promise<number[]> =>
      (await scanCodexLeaseProcesses(ENV, process.pid))?.tagged(lease) ?? []
    await expect.poll(tagged).toContain(owned.pid)
    expect(await tagged()).not.toContain(decoy.pid)
  })

  it('attributes a command that cleared its environment to the chat whose command started it', async () => {
    const lease = `lease-${process.pid}-${Date.now()}`
    const dir = await mkdtemp(join(tmpdir(), 'orca-lease-scan-'))
    dirs.push(dir)
    // A shell under the launcher's name stands in for it; `; :` keeps the tagged shell as parent.
    const launcherPath = join(dir, 'orca-provider-exec')
    await copyFile('/bin/sh', launcherPath)
    await chmod(launcherPath, 0o755)
    const launcher = spawn(
      launcherPath,
      ['-c', `${ENV}=${lease} /bin/sh -c 'env -i /bin/sleep 30; :' & wait`],
      { env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, stdio: 'ignore', detached: true }
    )
    groups.push(launcher.pid!)
    const tagged = async (): Promise<number> =>
      (await scanCodexLeaseProcesses(ENV, launcher.pid!))?.tagged(lease).length ?? 0
    // The tagged shell and the untagged sleep under it.
    await expect.poll(tagged).toBe(2)
  })
})
