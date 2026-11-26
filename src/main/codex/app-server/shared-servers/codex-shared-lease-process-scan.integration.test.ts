import { spawn } from 'node:child_process'
import { chmod, copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanCodexLeaseProcesses } from './codex-shared-lease-process-scan'

const ENV = 'ORCA_CODEX_SHARED_LEASE'
const groups: number[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const group of groups.splice(0)) {
    try {
      process.kill(-group, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** A shell under the launcher's name stands in for it (the scan reads only the launcher's subtree);
 *  `; :` keeps each tagged shell as its command's parent. */
async function fakeLauncher(script: string): Promise<number> {
  const dir = await mkdtemp(join(tmpdir(), 'orca-lease-scan-'))
  dirs.push(dir)
  const launcherPath = join(dir, 'orca-provider-exec')
  await copyFile('/bin/sh', launcherPath)
  await chmod(launcherPath, 0o755)
  const launcher = spawn(launcherPath, ['-c', script], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    stdio: 'ignore',
    detached: true
  })
  groups.push(launcher.pid!)
  return launcher.pid!
}

// macOS hides Apple binaries' environments and scans only under the server, so the real-process
// check runs where every own-user process is readable.
describe.skipIf(process.platform !== 'linux')('shared Codex lease process scan', () => {
  it('finds a process by the lease tag in its environment, never by the same text in its arguments', async () => {
    const lease = `lease-${process.pid}-${Date.now()}`
    const launcher = await fakeLauncher(
      `${ENV}=${lease} /bin/sleep 30 & ${ENV}=someone-else /bin/sh -c 'sleep 30; :' ${ENV}=${lease} & wait`
    )
    const scan = () => scanCodexLeaseProcesses(ENV, launcher)
    await expect.poll(async () => (await scan())?.tagged('someone-else').length ?? 0).toBe(2)
    expect((await scan())?.tagged(lease)).toHaveLength(1)
  })

  it('attributes a command that cleared its environment to the chat whose command started it', async () => {
    const lease = `lease-${process.pid}-${Date.now()}`
    const launcherPid = await fakeLauncher(
      `${ENV}=${lease} /bin/sh -c 'env -i /bin/sleep 30; :' & wait`
    )
    const tagged = async (): Promise<number> =>
      (await scanCodexLeaseProcesses(ENV, launcherPid))?.tagged(lease).length ?? 0
    // The tagged shell and the untagged sleep under it.
    await expect.poll(tagged).toBe(2)
  })
})
