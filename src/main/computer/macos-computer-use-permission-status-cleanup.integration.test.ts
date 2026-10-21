import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnProcess } from '@orca/process-host'
import type { ChildProcessHandle } from '@orca/process-host/process-spec'
import { afterEach, describe, expect, it } from 'vitest'
import { stopMacOSPermissionStatusHelper } from './macos-computer-use-permission-status-cleanup'

describe.skipIf(process.platform !== 'darwin')('real permission status helper cleanup', () => {
  const children: ChildProcessHandle[] = []
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

  async function startFixture(executablePath: string, args: string[]): Promise<ChildProcessHandle> {
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

  it('removes completed probes without stopping another probe, setup, or agent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-permission-[cleanup]+-'))
    directories.push(directory)
    const statusPath = join(directory, 'status.json')
    const executablePath = join(
      directory,
      'Orca Computer Use.app',
      'Contents',
      'MacOS',
      'orca-computer-use-macos'
    )
    const peers = await Promise.all([
      startFixture(executablePath, ['--permission-status-file', `${statusPath}.peer`]),
      startFixture(executablePath, ['--permission-status-file', join(directory, 'peer.json')]),
      startFixture(executablePath, ['--permission', 'accessibility']),
      startFixture(executablePath, ['--permissions']),
      startFixture(executablePath, ['--agent', statusPath]),
      startFixture(`${executablePath}-peer`, ['--permission-status-file', statusPath])
    ])

    for (let probe = 0; probe < 3; probe++) {
      const completed = await startFixture(executablePath, ['--permission-status-file', statusPath])
      const exited = once(completed, 'exit')

      await stopMacOSPermissionStatusHelper(statusPath)
      await exited

      expect(completed.signalCode).toBe('SIGTERM')
      expect(
        children.filter((child) => child.exitCode === null && child.signalCode === null)
      ).toHaveLength(peers.length)
    }
    for (const peer of peers) {
      expect(peer.exitCode).toBeNull()
      expect(peer.signalCode).toBeNull()
    }
  })
})
