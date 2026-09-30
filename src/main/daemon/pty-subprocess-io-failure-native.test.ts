import { fstatSync } from 'node:fs'
import * as pty from 'node-pty'
import { describe, expect, it, vi } from 'vitest'
import { createDaemonPtySubprocessHandle } from './pty-subprocess/subprocess-handle'
import { TerminalHost } from './terminal-host'

const describePosix = process.platform === 'win32' ? describe.skip : describe

describePosix('failed-I/O teardown with a real native PTY', () => {
  it.each([
    ['write', false],
    ['write', true],
    ['resize', false],
    ['resize', true]
  ] as const)(
    'reaps real shells and master fds after %s failure (immediate=%s)',
    async (operation, immediate) => {
      for (let cycle = 0; cycle < 4; cycle++) {
        const native = pty.spawn(
          '/bin/sh',
          [
            '-c',
            'printf "orca-cleanup-ready\\n"; while IFS= read -r line; do printf "reply:%s\\n" "$line"; done'
          ],
          {
            cwd: process.cwd(),
            cols: 80,
            rows: 24,
            env: { TERM: 'xterm-256color', PATH: '/usr/bin:/bin' }
          }
        )
        const fd = (native as pty.IPty & { fd: number }).fd
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
        const onExit = vi.fn()
        try {
          await host.createOrAttach({
            sessionId: 'native-io-failure',
            cols: 80,
            rows: 24,
            streamClient: {
              onData: (data) => {
                output += data
              },
              onExit
            }
          })
          await vi.waitFor(() => expect(output).toContain('orca-cleanup-ready'), { timeout: 3000 })
          handle.resize(100, 30)
          handle.write('roundtrip\n')
          await vi.waitFor(() => expect(output).toContain('reply:roundtrip'), { timeout: 3000 })
          host.pauseProducer('native-io-failure')
          expect(process.kill(native.pid, 0)).toBe(true)
          const failure = vi.spyOn(native, operation).mockImplementation(() => {
            throw new Error('injected I/O failure')
          })
          if (operation === 'write') {
            handle.write('ignored')
          } else {
            handle.resize(100, 30)
          }
          failure.mockRestore()

          await host.kill('native-io-failure', { immediate })
          await vi.waitFor(() => expect(onExit).toHaveBeenCalledOnce(), { timeout: 3000 })
          expect(host.listSessions()).toHaveLength(0)
          expect(() => process.kill(native.pid, 0)).toThrow(
            expect.objectContaining({ code: 'ESRCH' })
          )
          expect(() => fstatSync(fd)).toThrow(expect.objectContaining({ code: 'EBADF' }))
        } finally {
          // Only this test's still-owned native child is eligible for emergency cleanup.
          if (!exited) {
            native.kill('SIGKILL')
          }
          await vi.waitFor(() => expect(exited).toBe(true), { timeout: 3000 })
          await host.dispose()
        }
      }
    },
    15000
  )
})
