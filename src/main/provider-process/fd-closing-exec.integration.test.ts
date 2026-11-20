import { spawnProcess } from '@orca/process-host'
import { FD_CLOSING_EXEC_ARGS } from '@orca/process-host/fd-closing-exec-launch'
import { once } from 'node:events'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'

const helper = join(
  process.cwd(),
  'native/provider-exec/.build',
  `linux-${process.arch}`,
  'orca-provider-exec'
)

describe.runIf(process.platform === 'linux')('fd-closing exec', () => {
  it('keeps the IPC channel but not other inherited descriptors', async () => {
    const child = spawnProcess({
      program: helper,
      args: [
        ...FD_CLOSING_EXEC_ARGS,
        '/bin/sh',
        '-c',
        '[ -e /proc/self/fd/3 ] && echo ipc; [ -e /proc/self/fd/4 ] && echo leaked; true'
      ],
      // fd 3 is the IPC channel; fd 4 stands in for main's Chromium sockets.
      stdio: ['ignore', 'pipe', 'ignore', 'ipc', 'pipe'],
      env: process.env
    })
    let output = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    const [code] = await once(child, 'close')
    expect({ code, output }).toEqual({ code: 0, output: 'ipc\n' })
  })

  it('releases descriptors above the CLI protocol while the CLI runs', async () => {
    const child = spawnProcess({
      program: helper,
      args: ['--cli-input-fd7', '0', '0', 'session', 'stdin-end', '--', '/bin/sleep', '30'],
      // fd 8 stands in for main's Chromium sockets; only its EOF proves no helper pid holds it.
      stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
      detached: true,
      env: process.env
    })
    try {
      const leaked = child.stdio[8]
      if (!(leaked instanceof Readable)) {
        throw new Error('Missing stand-in descriptor')
      }
      leaked.resume()
      const released = await Promise.race([
        once(leaked, 'end').then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000))
      ])
      expect(released).toBe(true)
    } finally {
      // Closing the owner and gate pipes ends the watcher and the gated leader.
      for (const stream of child.stdio) {
        stream?.destroy()
      }
      child.kill('SIGKILL')
    }
  })

  it('still reports a missing program as ENOENT', async () => {
    const child = spawnProcess({
      program: 'orca-fd-closing-missing-program',
      fdClosingExec: helper,
      stdio: 'ignore'
    })
    const [error] = await once(child, 'error')
    expect(error).toMatchObject({ code: 'ENOENT' })
  })
})
