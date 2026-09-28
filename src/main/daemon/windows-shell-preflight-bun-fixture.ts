import { join } from 'node:path'
import { createWindowsBunPtyLaunch } from './pty-subprocess/windows-bun-pty-launch'
import { spawnBunPty } from './pty-subprocess/bun-pty-process'

export async function runWindowsShellPreflight(options: {
  shellPath: string
  shellArgs: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  input?: string
  timeoutMs?: number
}): Promise<{ output: string; exitCode: number }> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(options.env)) {
    if (value !== undefined) {
      env[key] = value
    }
  }
  const proc = spawnBunPty(
    {
      file: options.shellPath,
      args: options.shellArgs,
      cols: 100,
      rows: 30,
      cwd: options.cwd,
      env
    },
    {
      createWindowsLaunch: (args) =>
        createWindowsBunPtyLaunch(args, {
          workerPath: join(process.cwd(), 'out', 'terminal-daemon', 'windows-bun-pty-gate-entry.js')
        })
    }
  )
  let output = ''
  proc.onData((data) => {
    output += data
  })
  const exited = new Promise<number>((resolve) => {
    proc.onExit(({ exitCode }) => resolve(exitCode))
  })
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    if (options.input) {
      proc.write(options.input.replaceAll('\n', '\r'))
    }
    const exitCode = await Promise.race([
      exited,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`timed out waiting for Windows shell PTY:\n${output}`)),
          options.timeoutMs ?? 10_000
        )
      })
    ])
    return { output, exitCode }
  } finally {
    clearTimeout(timeout)
    proc.kill()
    await exited
    proc.destroy()
  }
}
