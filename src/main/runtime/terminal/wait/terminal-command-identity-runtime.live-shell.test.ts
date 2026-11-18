import type * as Crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { identifyTerminalCommand } from '../../../../shared/shell/launch/identified-terminal-command'
import { getDaemonBashShellReadyRcfileContent } from '../../../daemon/shell-readiness/daemon-bash-shell-ready-rcfile'
import { createTranscriptPane } from './agent-transcript-pane-test-harness'
import { failOnLaunchedAgentExit } from './launched-agent-exit-watch'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))
vi.mock('node:crypto', async (original) => {
  const actual = await original<typeof Crypto>()
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) }
})

it.skipIf(process.platform === 'win32')(
  'carries a generated command through runtime input and real shell output, then retires its wait',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-command-runtime-'))
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const rcfile = join(root, 'rcfile')
      writeFileSync(rcfile, getDaemonBashShellReadyRcfileContent())
      const writes: string[] = []
      const { runtime, handle } = await createTranscriptPane({
        paneTitle: 'shell',
        foregroundProcess: 'bash',
        data: '',
        onWrite: (data) => writes.push(data)
      })
      vi.mocked(randomUUID).mockReturnValueOnce('01234567-89ab-cdef-0123-456789abcdef')
      const launch = identifyTerminalCommand(
        '(__orca_osc133_emit_command_finished 0); false',
        'bash'
      )
      let active = 0
      const subscribe = runtime.subscribeToTerminalData.bind(runtime)
      vi.spyOn(runtime, 'subscribeToTerminalData').mockImplementation((ptyId, listener) => {
        active += 1
        const stop = subscribe(ptyId, listener)
        return () => {
          active -= 1
          stop()
        }
      })
      const independent = vi.fn()
      const stopIndependent = subscribe('pty-1', independent)
      let cancelled = false
      const waiting = failOnLaunchedAgentExit(
        runtime,
        'pty-1',
        'claude',
        undefined,
        (signal) =>
          new Promise<void>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('deadline')), 7_200_000)
            signal.addEventListener(
              'abort',
              () => {
                clearTimeout(timer)
                cancelled = true
                reject(new Error('cancelled'))
              },
              { once: true }
            )
          }),
        { commandId: launch.commandId!, alreadySubmitted: false }
      ).catch((error: unknown) => error)
      const sent = await runtime.sendTerminal(
        handle,
        { text: launch.command, enter: true },
        { inputKind: 'launch' }
      )
      expect(sent.accepted).toBe(true)
      const output = spawnSync('bash', ['--noprofile', '--rcfile', rcfile, '-i'], {
        input: `${writes.join('').replaceAll('\r', '\n')}true\nexit 0\n`,
        encoding: 'utf8',
        timeout: 10_000,
        env: { ...process.env, HOME: root, TERM: 'xterm', ORCA_SHELL_FEATURES: 'markers' }
      })
      expect(output.error).toBeUndefined()
      runtime.onPtyData('pty-1', output.stdout, 1)
      expect(await waiting).toMatchObject({
        name: 'TerminalCommandFinishedError',
        commandId: '0123456789abcdef0123456789abcdef',
        exitCode: 1
      })
      expect(cancelled).toBe(true)
      expect(active).toBe(0)
      runtime.onPtyData('pty-1', 'successor still produces output', 2)
      expect(independent.mock.lastCall?.[0]).toBe('successor still produces output')
      stopIndependent()
    } finally {
      clearTimeout(timer)
      vi.restoreAllMocks()
      rmSync(root, { recursive: true, force: true })
    }
  }
)
