import assert from 'node:assert/strict'
import { spawnBunPty } from './daemon/pty-subprocess/bun-pty-process'
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) {
      return true
    }
    await sleep(20)
  }
  return false
}

export async function runFishHistoryFixture({
  binary,
  home,
  dataHome,
  session,
  promptMark,
  marker
}: {
  binary: string
  home: string
  dataHome: string
  session: string
  promptMark: string
  marker: string
}): Promise<void> {
  const term = spawnBunPty({
    file: binary,
    args: ['-l', '-i'],
    cols: 120,
    rows: 30,
    cwd: home,
    // Fully pinned: no ambient HOME/XDG_* reaches fish, so this cannot pass
    // only on a machine whose real fish config happens to cooperate.
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: home,
      TERM: 'xterm-256color',
      // LC_ALL wins over any LANG/LC_* a host might contribute, pinning fish's locale.
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      XDG_CONFIG_HOME: home,
      XDG_DATA_HOME: dataHome,
      // The production injection under test (terminal-history.ts).
      fish_history: session
    }
  })

  let rendered = ''
  term.onData((chunk) => {
    rendered += chunk
    if (chunk.includes('\x1b[0c') || chunk.includes('\x1b[c')) {
      term.write('\x1b[?62;4;6;22c')
    }
    if (chunk.includes('\x1b[6n')) {
      term.write('\x1b[1;1R')
    }
    if (chunk.includes('\x1b]10;?') || chunk.includes('\x1b]11;?')) {
      term.write('\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\')
    }
  })
  let exited = false
  term.onExit(() => {
    exited = true
  })

  try {
    assert.equal(await waitUntil(() => rendered.includes(promptMark), 15_000), true)
    term.write(`${marker}\r`)
    assert.equal(
      await waitUntil(() => rendered.includes('orca-worktree-scoped-history'), 5_000),
      true
    )
    // fish flushes history on exit, so the read must wait for the process to go.
    term.write('exit\r')
    assert.equal(await waitUntil(() => exited, 10_000), true)
  } finally {
    if (!exited) {
      term.kill()
    }
    assert.equal(await waitUntil(() => exited, 3000), true)
    term.destroy()
  }
}
