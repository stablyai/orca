import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as pty from 'node-pty'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { loadNodePtyForTests } from '../orcad/orcad-node-slot-fixture'
import { SessionInputClosedError } from './daemon-errors'
import { createDaemonPtySubprocessHandle } from './pty-subprocess/subprocess-handle'
import { TerminalHost } from './terminal-host'

const describePosix = process.platform === 'win32' ? describe.skip : describe
const SESSION_ID = 'input-closed-delivery'

// #33021: a live child whose PTY master stopped taking input must not report delivered writes.
describePosix('input to a live child whose PTY master stopped taking input', () => {
  let nodePty: typeof pty
  let cleanup: (() => Promise<void>) | null = null
  beforeAll(async () => {
    nodePty = await loadNodePtyForTests()
  })
  afterEach(async () => {
    await cleanup?.()
    cleanup = null
  })

  async function startLoggingChild() {
    const root = mkdtempSync(join(tmpdir(), 'orca-input-closed-'))
    const log = join(root, 'stdin.log')
    // The child ignores hangup so it outlives its PTY master, like an agent that keeps running.
    const native = nodePty.spawn(
      '/bin/sh',
      [
        '-c',
        `trap "" HUP; printf "ready\\n"; while IFS= read -r line; do printf "%s\\n" "$line" >> "${log}"; done; sleep 30`
      ],
      { cwd: root, cols: 80, rows: 24, env: { TERM: 'xterm-256color', PATH: '/usr/bin:/bin' } }
    )
    let exited = false
    native.onExit(() => {
      exited = true
    })
    const handle = createDaemonPtySubprocessHandle({
      process: native,
      shellPath: '/bin/sh',
      spawnCwd: root,
      env: {},
      startupCommandDeliveredInShellArgs: false,
      reportsChildExitStatus: true,
      sessionId: SESSION_ID,
      startupAgentRecognition: null
    })
    const readinessEvents: { event: string; details: Record<string, unknown> }[] = []
    const host = new TerminalHost({
      spawnSubprocess: () => handle,
      reportReadinessEvent: (event, details) => readinessEvents.push({ event, details })
    })
    let output = ''
    const onInputClosed = vi.fn()
    const streamClient = {
      onData: (data: string) => {
        output += data
      },
      onExit: vi.fn(),
      onInputClosed
    }
    await host.createOrAttach({ sessionId: SESSION_ID, cols: 80, rows: 24, streamClient })
    cleanup = async () => {
      if (!exited) {
        native.kill('SIGKILL')
      }
      await vi.waitFor(() => expect(exited).toBe(true), { timeout: 3000 })
      await host.dispose()
      rmSync(root, { recursive: true, force: true })
    }
    await vi.waitFor(() => expect(output).toContain('ready'), { timeout: 3000 })
    const logged = (): string => (existsSync(log) ? readFileSync(log, 'utf8') : '')
    host.write(SESSION_ID, 'before\n')
    await vi.waitFor(() => expect(logged()).toContain('before'), { timeout: 3000 })
    return { native, host, streamClient, onInputClosed, readinessEvents, logged }
  }

  it('refuses input after a native resize failure instead of dropping it', async () => {
    const { native, host, streamClient, onInputClosed, readinessEvents } = await startLoggingChild()
    vi.spyOn(native, 'resize').mockImplementationOnce(() => {
      throw new Error('ioctl(2) failed, EBADF')
    })

    host.resize(SESSION_ID, 100, 30)

    expect(onInputClosed).toHaveBeenCalledOnce()
    expect(readinessEvents).toContainEqual({
      event: 'pty-input-closed',
      details: { sessionId: SESSION_ID, reason: 'resize_failed' }
    })
    expect(() => host.write(SESSION_ID, 'after\n')).toThrow(SessionInputClosedError)
    expect(process.kill(native.pid, 0)).toBe(true)
    const reattached = await host.createOrAttach({
      sessionId: SESSION_ID,
      cols: 100,
      rows: 30,
      streamClient
    })
    expect(reattached).toMatchObject({ isNew: false, inputClosed: true })
  })

  it('refuses input after the PTY master read stream fails while the child lives', async () => {
    const { native, host, onInputClosed, readinessEvents } = await startLoggingChild()
    const socket = '_socket' in native ? native._socket : undefined
    if (!(socket instanceof Socket)) {
      throw new Error('node-pty master stream is not a socket')
    }

    socket.destroy(Object.assign(new Error('read ENXIO'), { code: 'ENXIO' }))

    await vi.waitFor(() => expect(onInputClosed).toHaveBeenCalledOnce(), { timeout: 3000 })
    expect(readinessEvents).toContainEqual({
      event: 'pty-input-closed',
      details: { sessionId: SESSION_ID, reason: 'master_closed: read ENXIO' }
    })
    expect(() => host.write(SESSION_ID, 'after\n')).toThrow(SessionInputClosedError)
    expect(process.kill(native.pid, 0)).toBe(true)
  })
})
