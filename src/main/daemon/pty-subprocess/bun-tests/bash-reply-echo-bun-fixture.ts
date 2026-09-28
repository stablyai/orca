import { spawnBunPty } from '../bun-pty-process'
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && !predicate()) {
    await sleep(25)
  }
}

/**
 * Writes `reply` to the master once bash is settled, and returns what came back.
 * `discipline: 'cooked'` parks bash in `read` first, which restores ICANON+ECHO.
 */
export async function captureBashReplyEcho({
  reply,
  discipline
}: {
  reply: string
  discipline: 'readline' | 'cooked'
}): Promise<string> {
  let output = ''
  const pty = spawnBunPty({
    file: '/bin/bash',
    args: ['--norc', '--noprofile', '-i'],
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined
        )
      ),
      PS1: 'ORCA16542> ',
      TERM: 'xterm-256color'
    }
  })
  const exited = new Promise<void>((resolve) => pty.onExit(() => resolve()))
  try {
    pty.onData((data) => {
      output += data
    })

    await waitFor(() => output.includes('ORCA16542> '), 10_000)
    if (discipline === 'cooked') {
      pty.write('read -r ORCA_LINE\r')
      await sleep(400)
    }
    output = ''
    pty.write(reply)
    // No marker to wait on: the echo is all this produces, so settle instead.
    await waitFor(() => output.length > 0, 5_000)
    await sleep(250)
    return output
  } finally {
    pty.kill()
    await exited
    pty.destroy()
  }
}
