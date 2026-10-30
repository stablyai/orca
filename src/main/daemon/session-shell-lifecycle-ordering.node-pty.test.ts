import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createPtySubprocess } from './pty-subprocess'
import { Session } from './session'
import { inspectTerminalHostProcess } from './terminal-host-process-inspection'

describe.skipIf(process.platform === 'win32')('shell lifecycle producer ordering', () => {
  it.each([false, true])(
    'cannot replay an old prompt over an active builtin (DEBUG hook=%s)',
    async (debugHook) => {
      const home = mkdtempSync(join(tmpdir(), 'orca-lifecycle-ordering-'))
      const originalUserData = process.env.ORCA_USER_DATA_PATH
      process.env.ORCA_USER_DATA_PATH = join(home, 'orca-data')
      writeFileSync(
        join(home, '.bash_profile'),
        `unset HISTFILE; PS1='ORDER_PROMPT> '
${
  debugHook
    ? `__fixture_debug() { if [[ "\${__fixture_block:-}" == 1 && "$1" == "read -e -r -p "* ]]; then unset __fixture_block; read -e -r -p 'ORDER_READ_ACTIVE> ' debug_answer; fi; }
trap '__fixture_debug "$BASH_COMMAND"' DEBUG`
    : ''
}
`
      )
      let session: Session | undefined
      try {
        const subprocess = await createPtySubprocess({
          sessionId: 'ordering-fixture',
          cols: 80,
          rows: 24,
          cwd: home,
          shellOverride: '/bin/bash',
          command: ':',
          env: {
            HOME: home,
            SHELL: '/bin/bash',
            TERM: 'xterm-256color',
            PATH: process.env.PATH ?? '/usr/bin:/bin'
          }
        })
        const onData = subprocess.onData
        let held = ''
        let hold = false
        let deliver: (data: string) => void = () => {
          throw new Error('session listener not registered')
        }
        subprocess.onData = (listener) => {
          deliver = listener
          onData((data) => {
            if (hold) {
              held += data
            } else {
              listener(data)
            }
          })
        }
        const current = new Session({
          sessionId: 'ordering-fixture',
          cols: 80,
          rows: 24,
          subprocess,
          shellReadySupported: true
        })
        session = current
        let output = ''
        current.attachClient({
          onData: (data) => {
            output += data
          },
          onExit() {}
        })
        const inspect = () =>
          inspectTerminalHostProcess({
            sessionId: 'ordering-fixture',
            session: current,
            currentSession: () => current,
            expectedIncarnationId: current.incarnationId,
            includeShellLifecycle: true,
            authorityGeneration: 'fixture-host',
            nextObservationEpoch: () => 1
          })
        await vi.waitFor(() => expect(output).toContain('ORDER_PROMPT> '))
        await vi.waitFor(async () => expect((await inspect()).shellLifecycle?.phase).toBe('prompt'))
        hold = true
        current.write(debugHook ? '__fixture_block=1\r' : ':\r')
        await vi.waitFor(() => expect(held).toContain('ORDER_PROMPT> '))
        const oldCommandAndPrompt = held
        held = ''
        current.write("read -e -r -p 'ORDER_READ_ACTIVE> ' answer\r")
        await vi.waitFor(() => expect(held).toMatch(/ORDER_READ_ACTIVE> $/))
        // Deliver the old complete cycle while the new command's output remains queued.
        deliver(oldCommandAndPrompt)
        const result = await inspect()
        expect(result.childProcessEvidence).toBe('no-children')
        expect(result.shellLifecycle?.phase).not.toBe('prompt')
        expect(result.shellLifecycle?.confidence).toBe('none')
      } finally {
        if (session) {
          await session.forceKillAndWaitForExit(3_000)
          session.dispose()
        }
        if (originalUserData === undefined) {
          delete process.env.ORCA_USER_DATA_PATH
        } else {
          process.env.ORCA_USER_DATA_PATH = originalUserData
        }
        rmSync(home, { recursive: true, force: true })
      }
    },
    15_000
  )
})
