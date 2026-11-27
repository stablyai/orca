import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isProcessAlive } from '../../../shared/remote-runtime/serve-supervisor/serve-bundle-coordination'
import { findSystemSsh } from './system-ssh-binary'
import { spawnSystemSshCommand } from './system-ssh-command'
import { terminateSystemSsh } from './system-ssh-termination'

function waitForPidFile(path: string): Promise<number> {
  return vi.waitFor(
    () => {
      const pid = Number.parseInt(readFileSync(path, 'utf-8'), 10)
      if (!(pid > 0)) {
        throw new Error(`no pid in ${path} yet`)
      }
      return pid
    },
    { timeout: 5_000, interval: 25 }
  )
}

function waitForExit(pid: number): Promise<void> {
  return vi.waitFor(() => expect(isProcessAlive(pid)).toBe(false), {
    timeout: 2_000,
    interval: 25
  })
}

function exitOf(proc: ChildProcess): Promise<[number | null, NodeJS.Signals | null]> {
  return new Promise((resolve) => proc.once('exit', (code, signal) => resolve([code, signal])))
}

describe.skipIf(process.platform === 'win32')('terminateSystemSsh', () => {
  let dir = ''
  let proxyPid: number | null = null
  let cleanupSsh: (() => void) | null = null

  afterEach(() => {
    cleanupSsh?.()
    cleanupSsh = null
    if (proxyPid && isProcessAlive(proxyPid)) {
      process.kill(proxyPid, 'SIGKILL')
    }
    proxyPid = null
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
    }
    dir = ''
  })

  function makeTempDir(): string {
    dir = mkdtempSync(join(tmpdir(), 'orca-ssh-termination-'))
    return dir
  }

  /** Stands in for ssh with a forked proxy: `onTerm` decides whether SIGTERM is handled or fatal. */
  async function startSshStandIn(onTerm: string): Promise<{ proc: ChildProcess; proxy: number }> {
    const pidFile = join(makeTempDir(), 'proxy.pid')
    const proc = spawn('/bin/sh', ['-c', `${onTerm}sleep 300 & echo $! > "${pidFile}"; wait`], {
      stdio: 'ignore'
    })
    cleanupSsh = () => proc.kill('SIGKILL')
    proxyPid = await waitForPidFile(pidFile)
    return { proc, proxy: proxyPid }
  }

  it('leaves the proxy alone when ssh handles SIGTERM and exits with a code', async () => {
    // Like a ControlPersist mux client, whose proxy carries the shared master's connection.
    const { proc, proxy } = await startSshStandIn(`trap 'exit 255' TERM; `)
    const exited = exitOf(proc)

    terminateSystemSsh(proc)

    expect(await exited).toEqual([255, null])
    // ast-grep-ignore: test-no-real-time-wait -- proves a real proxy survives; a wrong hang-up would land after an async process-table read
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(isProcessAlive(proxy)).toBe(true)
  })

  it('hangs up the proxy when SIGTERM kills ssh before its handlers run', async () => {
    const { proc, proxy } = await startSshStandIn('')
    const exited = exitOf(proc)

    terminateSystemSsh(proc)

    expect(await exited).toEqual([null, 'SIGTERM'])
    await waitForExit(proxy)
  })

  it.skipIf(!findSystemSsh())(
    'ends the real ProxyCommand child when a channel closes before OpenSSH finishes connecting',
    async () => {
      const configFile = join(makeTempDir(), 'ssh_config')
      const pidFile = join(dir, 'proxy.pid')
      writeFileSync(configFile, '')
      const channel = spawnSystemSshCommand(
        {
          id: 'proxy-target',
          label: 'proxy-target',
          source: 'manual',
          host: 'orca-unreachable.invalid',
          port: 22,
          username: 'orca',
          systemSshConnectionReuse: false,
          // Never answers the SSH banner, so ssh stays in its pre-session connect phase.
          proxyCommand: `/bin/sh -c 'echo $$ > "${pidFile}"; exec sleep 300'`
        },
        'true',
        { configFile, nonInteractive: true, closeStdin: true }
      )
      cleanupSsh = () => channel.close()
      channel.stderr.resume()
      channel.resume()
      // The proxy inherits ssh's stderr, so 'close' waits on it; 'exit' does not.
      const exited = new Promise<void>((resolve) => channel.once('exit', () => resolve()))
      proxyPid = await waitForPidFile(pidFile)

      channel.close()
      await exited

      await waitForExit(proxyPid)
    }
  )
})
