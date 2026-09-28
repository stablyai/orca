import { describe, expect, it } from 'vitest'
import { bunRelayPtyModule } from './relay-pty-runtime'

describe.skipIf(!process.versions.bun)('real Bun relay PTY', () => {
  it('delivers output and exit after asynchronous admission', async () => {
    const windows = process.platform === 'win32'
    const shell = windows ? (process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe') : '/bin/sh'
    const args = windows
      ? ['/d', '/c', 'echo ORCA_RELAY_BUN_OK']
      : ['-c', "printf 'ORCA_RELAY_BUN_OK\\n'"]
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined
      )
    )
    const terminal = await bunRelayPtyModule.spawn(shell, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env
    })
    let output = ''
    const data = terminal.onData((chunk) => {
      output += chunk
    })
    let exitSubscription: { dispose(): void } | undefined
    try {
      const exited = new Promise<number>((resolve) => {
        exitSubscription = terminal.onExit(({ exitCode }) => resolve(exitCode))
      })
      expect(await exited).toBe(0)
      expect(output).toContain('ORCA_RELAY_BUN_OK')
    } finally {
      data.dispose()
      exitSubscription?.dispose()
      terminal.kill()
    }
  }, 15_000)
})
