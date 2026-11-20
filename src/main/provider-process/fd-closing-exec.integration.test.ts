import { spawnProcess } from '@orca/process-host'
import { FD_CLOSING_EXEC_ARGS, setFdClosingExec } from '@orca/process-host/fd-closing-exec-launch'
import { once } from 'node:events'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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
      const leaked = child.stdio.at(8)
      if (!(leaked instanceof Readable)) {
        throw new Error('Missing stand-in descriptor')
      }
      leaked.resume()
      const released = once(leaked, 'end')
      // The status frame comes after the helper forked its leader and watcher.
      const status = child.stdio.at(5)
      if (!(status instanceof Readable)) {
        throw new Error('Missing status pipe')
      }
      await once(status, 'data')
      await released
      const stat = await readFile(`/proc/${child.pid}/stat`, 'utf8')
      expect(stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3)).not.toBe('Z')
    } finally {
      // Closing the owner and gate pipes ends the watcher and the gated leader.
      for (const stream of child.stdio) {
        stream?.destroy()
      }
      child.kill('SIGKILL')
    }
  })

  it('still reports a missing program, interpreter or loader as ENOENT', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orca-fd-closing-'))
    const script = join(dir, 'broken-interpreter')
    await writeFile(script, '#!/orca-fd-closing-missing-interpreter\n')
    // Linux looks for an interpreter literally named `/bin/sh\r`.
    const crlfScript = join(dir, 'crlf-interpreter')
    await writeFile(crlfScript, '#!/bin/sh\r\ntrue\r\n')
    // An ELF whose loader is missing: exec fails with ENOENT after the file itself checks out.
    const elf = await readFile('/bin/true')
    const loaderEnd = elf.indexOf(0, elf.indexOf('ld-linux'))
    elf[loaderEnd - 1] = 'X'.charCodeAt(0)
    const missingLoader = join(dir, 'missing-loader')
    await writeFile(missingLoader, elf)
    for (const file of [script, crlfScript, missingLoader]) {
      await chmod(file, 0o755)
    }
    setFdClosingExec(helper)
    try {
      for (const program of [
        'orca-fd-closing-missing-program',
        script,
        crlfScript,
        missingLoader
      ]) {
        const child = spawnProcess({ program, closeInheritedFds: true, stdio: 'ignore' })
        const [error] = await once(child, 'error')
        // A noexec tmpdir makes the direct spawn report EACCES; either way it's an error, not 127.
        expect(['ENOENT', 'EACCES']).toContain((error as NodeJS.ErrnoException).code)
      }
    } finally {
      setFdClosingExec(undefined)
      await rm(dir, { recursive: true, force: true })
    }
  })
})
