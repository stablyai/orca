import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnProcess } from '@orca/process-host'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { reapLeftoverMacOSPermissionStatusHelpers } from './macos-permission-status-leftover-reap'

describe.skipIf(process.platform !== 'darwin')('leftover permission status helper reap', () => {
  const children: ChildProcess[] = []
  const directories: string[] = []

  afterEach(async () => {
    await Promise.all(
      children.splice(0).map(async (child) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          return
        }
        const exited = once(child, 'exit')
        child.kill('SIGKILL')
        await exited
      })
    )
    await Promise.all(
      directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
    )
  })

  async function startFixture(args: string[]): Promise<ChildProcess> {
    const executablePath = join(
      tmpdir(),
      'Orca Computer Use.app',
      'Contents',
      'MacOS',
      'orca-computer-use-macos'
    )
    const child = spawnProcess({
      program: process.execPath,
      args: [
        '-e',
        "setInterval(() => {}, 1000); process.stdout.write('ready')",
        '--',
        executablePath,
        ...args
      ],
      stdio: 'pipe'
    })
    children.push(child)
    await once(child.stdout, 'data')
    return child
  }

  async function probeDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'orca-computer-use-permissions-'))
    directories.push(directory)
    return directory
  }

  it('kills a probe whose directory is gone and leaves live probes, setup and the agent alone', async () => {
    const finished = await probeDirectory()
    await rm(finished, { recursive: true })
    const live = await probeDirectory()
    const leaked = await startFixture(['--permission-status-file', join(finished, 'status.json')])
    const leakedExit = once(leaked, 'exit')
    const peers = await Promise.all([
      startFixture(['--permission-status-file', join(live, 'status.json')]),
      startFixture(['--permission-status-file', join(finished, 'other.json')]),
      startFixture(['--agent', join(finished, 'status.json')]),
      startFixture(['--permission', 'accessibility']),
      startFixture(['--permissions'])
    ])

    await reapLeftoverMacOSPermissionStatusHelpers()
    await leakedExit

    expect(leaked.signalCode).toBe('SIGKILL')
    for (const peer of peers) {
      expect(peer.exitCode).toBeNull()
      expect(peer.signalCode).toBeNull()
    }
  })
})
