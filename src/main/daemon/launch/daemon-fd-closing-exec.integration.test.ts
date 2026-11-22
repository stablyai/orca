import { spawnProcess } from '@orca/process-host'
import { once } from 'node:events'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FD_CLOSING_EXEC_ARGS } from './daemon-fd-closing-exec'

const helper = join(
  process.cwd(),
  'native/provider-exec/.build',
  `linux-${process.arch}`,
  'orca-provider-exec'
)

describe.runIf(process.platform === 'linux')('daemon fd-closing exec', () => {
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
})
