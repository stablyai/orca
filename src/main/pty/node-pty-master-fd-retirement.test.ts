import * as pty from 'node-pty'
import { describe, expect, it } from 'vitest'

/** Pin retirement of Terminal and write-stream fds (config/patches/node-pty@1.1.0.patch).
 * libuv closes before JS close handling, leaving a race that callers must guard; npm-installed relays lack this patch. */

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

/** Terminal.close shadows write(), but pending CustomWriteStream writes retain their own copied fd. */
function writeStream(term: pty.IPty): CustomWriteStream {
  return (term as unknown as { _writeStream: CustomWriteStream })._writeStream
}

/** Natural EIO/EOF must retire stream fds without an explicit destroy(). */
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
  return { term, spawnFd }
}

// Windows resize uses the ConPTY agent and never consults a master fd.
const describeOnPosix = process.platform === 'win32' ? describe.skip : describe

describeOnPosix('node-pty master fd retirement', () => {
  it('invalidates the descriptor once it gives up the handle', async () => {
    const { term, spawnFd } = await retiredPty()

    expect(spawnFd).toBeGreaterThanOrEqual(0)
    expect(masterFd(term)).toBe(-1)
  }, 15000)

  it('answers a resize past retirement without issuing the ioctl', async () => {
    const { term } = await retiredPty()

    expect(() => term.resize(200, 50)).not.toThrow()
    // Retired resize must not claim unapplied geometry.
    expect([term.cols, term.rows]).toEqual([80, 24])
  }, 15000)

  it('retires the write stream fd on _close(), not only on destroy()', async () => {
    const { term } = await retiredPty('exit 0', { destroy: false })

    // Retiring Terminal._fd alone leaves the stream pointing at a reusable descriptor.
    expect(writeStream(term)._fd).toBe(-1)

    writeStream(term).write('x')
    expect(writeStream(term)._writeQueue).toHaveLength(0)
  }, 15000)

  it('names the spawn file rather than tcgetpgrp on a retired descriptor', async () => {
    const { term } = await retiredPty()

    expect(term.process).toBe(POSIX_SHELL)
  }, 15000)
})

// Linux reuses the lowest free fd; await every fixture exit so leaked descriptors cannot invalidate the next case.
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
      // Establish actual reuse so the safety assertion cannot pass vacuously.
      expect(masterFd(live)).toBe(spawnFd)

      // Previously resized an unrelated terminal through its recycled fd.
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

      // Previously wrote into the new terminal; line-discipline echo makes the leak observable.
      writeStream(retired).write('leak\r')

      // Await exit so this fd cannot remain open and shift the next case's reuse premise.
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

    // exec makes the foreground cmdline distinguishable from the original shell.
    const live = spawnPty('exec sleep 5')
    try {
      expect(masterFd(live)).toBe(spawnFd)
      // Wait until exec replaces the shell cmdline.
      await new Promise<void>((resolve) => setTimeout(resolve, 300))

      // Retired process lookup must not attribute the new terminal's foreground process.
      expect(retired.process).toBe(POSIX_SHELL)
    } finally {
      live.kill()
    }
  }, 15000)
})
