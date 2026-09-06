import * as pty from 'node-pty'
import { describe, expect, it } from 'vitest'

/**
 * node-pty hands the master fd to libuv, which closes it on EIO/EOF, but upstream
 * never invalidated `_fd`, and none of the three fd-addressed surfaces consulted
 * anything: `resize()`, the `process` getter, and `CustomWriteStream`, which holds
 * its own plain-number copy of the fd taken at spawn. Orca's patch retires all
 * three in the same block that gives up the handle
 * (config/patches/node-pty@1.1.0.patch).
 *
 * Scope: this narrows the window, it does not close it. libuv closes the fd
 * synchronously inside `uv_close`, before the JS `'close'` that runs `_close()`,
 * so callers still need their own liveness verdict for that tick — and a relay
 * host installs node-pty from npm, where this patch is not applied at all.
 */

const POSIX_SHELL = '/bin/sh'

function spawnPty(command: string, cols = 80, rows = 24): pty.IPty {
  return pty.spawn(POSIX_SHELL, ['-c', command], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: process.cwd(),
    env: { ...process.env }
  })
}

function masterFd(term: pty.IPty): number {
  return (term as unknown as { fd: number }).fd
}

type CustomWriteStream = { _fd: number; _writeQueue: unknown[]; write(data: string): void }

/**
 * `Terminal._close()` already shadows `terminal.write` with a no-op, so the stream
 * itself is the surface that still reached the fd: a residual `_writeQueue` and an
 * in-flight `fs.write` both re-enter it after the close.
 */
function writeStream(term: pty.IPty): CustomWriteStream {
  return (term as unknown as { _writeStream: CustomWriteStream })._writeStream
}

/**
 * Run `command` to completion and let node-pty finish giving up the master.
 *
 * `destroy: false` exercises only the EIO/EOF read-error path, which reaches
 * `_close()` without ever calling `destroy()` — the path the exit of a shell
 * actually takes, and the one the write stream was previously never told about.
 */
async function retiredPty(
  command = 'exit 0',
  { destroy = true }: { destroy?: boolean } = {}
): Promise<{ term: pty.IPty; spawnFd: number }> {
  const term = spawnPty(command)
  const spawnFd = masterFd(term)
  await new Promise<void>((resolve) => {
    term.onExit(() => resolve())
  })
  if (destroy) {
    ;(term as unknown as { destroy?: () => void }).destroy?.()
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 400))
  return { term, spawnFd }
}

// Windows never reaches this code: WindowsTerminal.resize goes through the conpty
// agent and reads no fd, so the sentinel is written and never consulted there.
const describeOnPosix = process.platform === 'win32' ? describe.skip : describe

describeOnPosix('node-pty master fd retirement', () => {
  it('invalidates the descriptor once it gives up the handle', async () => {
    const { term, spawnFd } = await retiredPty()

    expect(spawnFd).toBeGreaterThanOrEqual(0)
    expect(masterFd(term)).toBe(-1)
  }, 15000)

  it('answers a resize past retirement without issuing the ioctl', async () => {
    const { term } = await retiredPty()

    // Pre-patch this threw `ioctl(2) failed, EBADF` out of whatever called it.
    expect(() => term.resize(200, 50)).not.toThrow()
    // Geometry stays at the last size actually applied rather than claiming one
    // that no descriptor ever received.
    expect([term.cols, term.rows]).toEqual([80, 24])
  }, 15000)

  it('retires the write stream fd on _close(), not only on destroy()', async () => {
    const { term } = await retiredPty('exit 0', { destroy: false })

    // The stream copied the fd number at spawn, so `Terminal._fd = -1` alone
    // leaves it addressing a descriptor the kernel may already have reissued.
    expect(writeStream(term)._fd).toBe(-1)

    writeStream(term).write('x')
    expect(writeStream(term)._writeQueue).toHaveLength(0)
  }, 15000)

  it('names the spawn file rather than tcgetpgrp on a retired descriptor', async () => {
    const { term } = await retiredPty()

    expect(term.process).toBe(POSIX_SHELL)
  }, 15000)
})

// Linux frees the master synchronously enough that the very next pty is handed the
// same descriptor number every time, which makes the reuse hazard directly
// observable rather than a race to reproduce.
//
// Which is also the constraint on writing a case here: the kernel hands out the
// lowest free number, so a case that returns while its live pty is still open
// leaks that descriptor into the next case's premise as an off-by-one. Await the
// exit, never a fixed sleep.
const describeOnLinux = process.platform === 'linux' ? describe : describe.skip

describeOnLinux('node-pty master fd reuse', () => {
  it('cannot resize a live pty handed the retired descriptor number', async () => {
    const { term: retired, spawnFd } = await retiredPty()

    const live = spawnPty('sleep 1; stty size')
    let output = ''
    live.onData((data) => {
      output += data
    })
    try {
      // The premise of this test: the kernel really did reissue the number. If it
      // stops holding, the assertion below would pass for the wrong reason.
      expect(masterFd(live)).toBe(spawnFd)

      // Pre-patch this reached TIOCSWINSZ on `live`'s master and silently resized
      // a terminal it has no relationship to — no error, nothing for a liveness
      // probe of the retired pid to observe.
      retired.resize(200, 50)

      await new Promise<void>((resolve) => {
        live.onExit(() => resolve())
      })
      expect(output.trim()).toBe('24 80')
    } finally {
      live.kill()
    }
  }, 15000)

  it('cannot write into a live pty handed the retired descriptor number', async () => {
    const { term: retired, spawnFd } = await retiredPty('exit 0', { destroy: false })

    const live = spawnPty('sleep 1')
    let output = ''
    live.onData((data) => {
      output += data
    })
    try {
      expect(masterFd(live)).toBe(spawnFd)

      // Pre-patch this fs.write reached `live`'s master, and the line discipline
      // echoed it straight back: a retired pane's bytes landing in an unrelated
      // terminal. Nothing has to read them for the leak to be observable.
      writeStream(retired).write('leak\r')

      // Await the exit rather than sleeping: a fixed wait leaves this descriptor
      // open into the next case, whose `expect(masterFd(live)).toBe(spawnFd)`
      // premise then sees the kernel hand out the lower number this pty was still
      // holding. That is what broke `node 24 1/8` on Linux, where alone among the
      // platforms these cases actually run.
      await new Promise<void>((resolve) => {
        live.onExit(() => resolve())
      })
      expect(output).not.toContain('leak')
    } finally {
      live.kill()
    }
  }, 15000)

  it('does not name a live pty foreground process off the retired descriptor', async () => {
    const { term: retired, spawnFd } = await retiredPty()

    // `exec` replaces the shell, so the foreground pgrp's cmdline is distinct
    // from the file this pty was spawned with.
    const live = spawnPty('exec sleep 5')
    try {
      expect(masterFd(live)).toBe(spawnFd)
      // Let the shell finish exec'ing, or its own cmdline is still the fallback.
      await new Promise<void>((resolve) => setTimeout(resolve, 300))

      // Pre-patch this read tcgetpgrp off `live`'s master and reported `sleep`,
      // attributing an unrelated pane's process to a pty that had already exited.
      expect(retired.process).toBe(POSIX_SHELL)
    } finally {
      live.kill()
    }
  }, 15000)
})
