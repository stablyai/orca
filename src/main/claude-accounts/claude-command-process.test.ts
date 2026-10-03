import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'

vi.mock('../../shared/child-process/run-process', () => ({
  spawnProcess: (options: { args: string[] }) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      stdin: null,
      kill: () => {}
    })
    setTimeout(() => {
      // What the guest prints when claude is not installed in the distro.
      const script = options.args.at(-1) ?? ''
      const begin = /__ORCA_WSL_CAPTURE_BEGIN_[a-z0-9]+__/.exec(script)?.[0] ?? ''
      const end = /__ORCA_WSL_CAPTURE_END_[a-z0-9]+__/.exec(script)?.[0] ?? ''
      child.stdout.emit(
        'data',
        Buffer.from(
          `To run a command as administrator (user "root"), use "sudo <command>".\n${begin}`
        )
      )
      child.stderr.emit('data', Buffer.from('bash: line 2: claude: command not found\n'))
      child.stdout.emit('data', Buffer.from(end))
      child.emit('close', 127)
    }, 0)
    return child
  }
}))

it('shows only what the WSL command itself printed when it fails, not the capture fences or banner', async () => {
  const { runClaudeCommandProcess } = await import('./claude-command-process')
  await expect(
    runClaudeCommandProcess(
      ['auth', 'status', '--json'],
      {
        windowsPath: '\\\\wsl.localhost\\Ubuntu\\home\\u\\p',
        linuxPath: '/home/u/p',
        wslDistro: 'Ubuntu'
      },
      5_000
    )
  ).rejects.toThrow(/^Claude command failed: bash: line 2: claude: command not found$/)
})
