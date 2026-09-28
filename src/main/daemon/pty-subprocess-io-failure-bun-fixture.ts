import assert from 'node:assert/strict'
import { readdirSync, readlinkSync } from 'node:fs'
import { runProcessSync } from '../../shared/child-process/run-process'
import { spawnBunPty } from './pty-subprocess/bun-pty-process'
import { createDaemonPtySubprocessHandle } from './pty-subprocess/subprocess-handle'
import { TerminalHost } from './terminal-host'

function terminalDescriptors(): number {
  if (process.platform === 'linux') {
    return readdirSync('/proc/self/fd')
      .flatMap((fd) => {
        try {
          return [readlinkSync(`/proc/self/fd/${fd}`)]
        } catch {
          return []
        }
      })
      .filter((path) => /\/dev\/(ptmx|pts\/)/.test(path)).length
  }
  const result = runProcessSync({
    program: 'lsof',
    args: ['-p', String(process.pid)],
    timeoutMs: 5000
  })
  assert.equal(result.code, 0, result.stderr)
  return result.stdout
    .split('\n')
    .filter((line) => /\/dev\/(ptmx|ttys[0-9])|\(revoked\)/.test(line)).length
}

async function waitUntil(
  predicate: () => boolean,
  message = 'PTY lifecycle deadline exceeded'
): Promise<void> {
  const deadline = Date.now() + 3000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

export async function runNativeIoFailureFixture({
  operation,
  immediate
}: {
  operation: 'write' | 'resize'
  immediate: boolean
}): Promise<number> {
  const before = terminalDescriptors()
  for (let cycle = 0; cycle < 4; cycle++) {
    const native = spawnBunPty({
      file: '/bin/sh',
      args: [
        '-c',
        'printf "orca-cleanup-ready\\n"; while IFS= read -r line; do printf "reply:%s\\n" "$line"; done'
      ],
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      env: { TERM: 'xterm-256color', PATH: '/usr/bin:/bin' }
    })
    let exited = false
    native.onExit(() => {
      exited = true
    })
    const handle = createDaemonPtySubprocessHandle({
      process: native,
      shellPath: '/bin/sh',
      spawnCwd: process.cwd(),
      env: {},
      startupCommandDeliveredInShellArgs: false,
      reportsChildExitStatus: true,
      sessionId: 'native-io-failure',
      startupAgentRecognition: null
    })
    const host = new TerminalHost({ spawnSubprocess: () => handle })
    let output = ''
    let exitEvents = 0
    try {
      await host.createOrAttach({
        sessionId: 'native-io-failure',
        cols: 80,
        rows: 24,
        streamClient: {
          onData: (data) => {
            output += data
          },
          onExit: () => {
            exitEvents++
          }
        }
      })
      await waitUntil(() => output.includes('orca-cleanup-ready'))
      handle.resize(100, 30)
      handle.write('roundtrip\n')
      await waitUntil(() => output.includes('reply:roundtrip'))
      host.pauseProducer('native-io-failure')
      assert.equal(process.kill(native.pid, 0), true)
      const originalWrite = native.write
      const originalResize = native.resize
      native[operation] = () => {
        throw new Error('injected I/O failure')
      }
      if (operation === 'write') {
        handle.write('ignored')
      } else {
        handle.resize(100, 30)
      }
      native.write = originalWrite
      native.resize = originalResize
      await host.kill('native-io-failure', { immediate })
      await waitUntil(() => exitEvents === 1)
      assert.equal(host.listSessions().length, 0)
      assert.throws(() => process.kill(native.pid, 0), { code: 'ESRCH' })
    } finally {
      if (!exited) {
        native.kill('SIGKILL')
      }
      await waitUntil(() => exited)
      await host.dispose()
      native.destroy()
    }
    // Bun closes its duplicated POSIX reader/writer fds off-thread after the exit callback.
    await waitUntil(() => terminalDescriptors() === before, 'native terminal descriptor leaked')
    assert.equal(terminalDescriptors(), before, 'native terminal descriptor leaked')
  }
  return 4
}
