import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnBunPty } from '../daemon/pty-subprocess/bun-pty-process'

type PosixShell = 'bash' | 'zsh'

export async function runInteractivePosixPty(args: {
  rcfileContent: string
  env: Record<string, string>
  input: string
  cwd: string
  shell?: PosixShell
}): Promise<string> {
  const rcfile = join(args.cwd, 'rcfile')
  writeFileSync(rcfile, args.rcfileContent)
  const shell = args.shell ?? 'bash'
  const shellArgs = shell === 'bash' ? ['--noprofile', '--rcfile', rcfile, '-i'] : ['-f', '-i']

  const proc = spawnBunPty({
    file: shell,
    args: shellArgs,
    cols: 100,
    rows: 30,
    cwd: args.cwd,
    env: { ...args.env, ORCA_TEST_RCFILE: rcfile }
  })

  let output = ''
  proc.onData((data) => {
    output += data
  })

  const exitPromise = new Promise<{ exitCode: number }>((resolve) => {
    proc.onExit(({ exitCode }) => resolve({ exitCode }))
  })

  let timeout: ReturnType<typeof setTimeout> | null = null
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`timed out waiting for ${shell} PTY output:\n${output}`)),
      5000
    )
  })

  try {
    const input = shell === 'zsh' ? `source "$ORCA_TEST_RCFILE"\n${args.input}` : args.input
    proc.write(input.replace(/\n/g, '\r'))
    const { exitCode } = await Promise.race([exitPromise, timeoutPromise])
    if (exitCode !== 0) {
      throw new Error(`Shell exited ${exitCode}: ${output}`)
    }
    return output
  } finally {
    if (timeout !== null) {
      clearTimeout(timeout)
    }
    try {
      proc.kill()
    } catch {
      // The process may already have exited normally before cleanup runs.
    }
  }
}
