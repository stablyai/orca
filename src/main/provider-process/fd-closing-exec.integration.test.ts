import { spawnProcess } from '@orca/process-host'
import { FD_CLOSING_EXEC_ARGS, setFdClosingExec } from '@orca/process-host/fd-closing-exec-launch'
import { once } from 'node:events'
import { chmod, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
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

  it('reports exec failures as an error and a close, never spawn or exit 127', async () => {
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
    // No `#!`: a direct spawn on Linux runs it under /bin/sh (execvp), so the wrapped one must too.
    const noShebang = join(dir, 'no-shebang')
    await writeFile(noShebang, 'true\n')
    const busy = join(dir, 'busy')
    await writeFile(busy, await readFile('/bin/true'))
    for (const file of [script, crlfScript, missingLoader, noShebang, busy]) {
      await chmod(file, 0o755)
    }
    // Held open for writing, so exec fails with ETXTBSY.
    const writer = await open(busy, 'r+')
    setFdClosingExec(helper)
    try {
      for (const [program, codes] of [
        ['orca-fd-closing-missing-program', ['ENOENT']],
        [script, ['ENOENT']],
        [crlfScript, ['ENOENT']],
        [missingLoader, ['ENOENT']],
        [busy, ['ETXTBSY']]
      ] as const) {
        const child = spawnProcess({ program, closeInheritedFds: true, stdio: 'ignore' })
        const events: string[] = []
        for (const event of ['spawn', 'exit', 'error'] as const) {
          child.on(event, () => events.push(event))
        }
        const [error] = await once(child, 'error')
        const [code] = await once(child, 'close')
        // A noexec tmpdir makes the direct spawn report EACCES instead; still an error, not 127.
        expect([...codes, 'EACCES']).toContain(error.code)
        expect({ program, events, code }).toEqual({ program, events: ['error'], code: error.errno })
      }
      // Fails before the helper runs, so the error must still name the program, not the helper.
      const noCwd = spawnProcess({
        program: '/bin/true',
        cwd: join(dir, 'missing-cwd'),
        closeInheritedFds: true,
        stdio: 'ignore'
      })
      const [cwdError] = await once(noCwd, 'error')
      expect({ path: cwdError.path, message: cwdError.message }).toEqual({
        path: '/bin/true',
        message: 'spawn /bin/true ENOENT'
      })
      const wrapped = spawnProcess({
        program: '/bin/true',
        closeInheritedFds: true,
        stdio: 'ignore'
      })
      expect(wrapped.spawnfile).toBe(helper)
      await once(wrapped, 'spawn')
      expect((await once(wrapped, 'close'))[0]).toBe(0)
      const shellRun = spawnProcess({
        program: noShebang,
        closeInheritedFds: true,
        stdio: 'ignore'
      })
      await once(shellRun, 'spawn')
      expect((await once(shellRun, 'close'))[0]).toBe(0)
    } finally {
      await writer.close()
      setFdClosingExec(undefined)
      await rm(dir, { recursive: true, force: true })
    }
  })
})
