import assert from 'node:assert/strict'
import path from 'node:path'
import { spawnBunPty } from '../bun-pty-process'
import { PtyStartupIngress } from '../../../../shared/pty-startup-ingress'
const PROMPT_MARK = 'ORCA13892> '

/* oxlint-disable no-control-regex -- terminal query grammars are control sequences */
/** Anchored at an ESC, first match wins; reply values match xterm.js's. */
const QUERY_GRAMMARS = [
  {
    re: /^\x1b\]1[012];\?(\x07|\x1b\\)/,
    reply: (m: RegExpExecArray) => `\x1b]11;rgb:1e1e/1e1e/1e1e${m[1]}`
  },
  { re: /^\x1b\[\?6n/, reply: () => '\x1b[?1;1;1R' },
  { re: /^\x1b\[6n/, reply: () => '\x1b[1;1R' },
  { re: /^\x1b\[\?996n/, reply: () => '\x1b[?997;1n' },
  { re: /^\x1b\[>0?c/, reply: () => '\x1b[>0;276;0c' },
  { re: /^\x1b\[0?c/, reply: () => '\x1b[?1;2c' },
  { re: /^\x1b\[>0?q/, reply: () => '\x1bP>|Orca\x1b\\' },
  { re: /^\x1b\[\?u/, reply: () => '\x1b[?0u' }
] as const
/** Still accumulating: no CSI final byte and no OSC/DCS terminator yet. */
const PARTIAL_QUERY_RE =
  /^(?:\x1b|\x1b\[[?>=]?[0-9;]*|\x1b\][0-9]*(?:;[^\x07\x1b]*)?\x1b?|\x1bP[^\x1b]*\x1b?)$/
/* oxlint-enable no-control-regex */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) {
      return true
    }
    await sleep(10)
  }
  return false
}

export async function runFishQueryReplyFixture({
  binary,
  configHome,
  childScript,
  nodeBinary
}: {
  binary: string
  configHome: string
  childScript: string
  nodeBinary: string
}): Promise<void> {
  const term = spawnBunPty({
    file: binary,
    args: ['-l', '-i'],
    cols: 120,
    rows: 30,
    cwd: configHome,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: configHome,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      LANG: 'en_US.UTF-8',
      XDG_CONFIG_HOME: configHome,
      XDG_DATA_HOME: path.join(configHome, 'data'),
      ORCA_NODE_BIN: nodeBinary,
      ORCA_CHILD_SCRIPT: childScript
    }
  })

  let rendered = ''
  const ingress = new PtyStartupIngress({
    ownerBackend: 'posix-pty',
    write: (data) => term.write(data),
    onEmission: (emission) => {
      rendered += emission.data
      answerQueriesInOrder(emission.data)
    }
  })

  // The host gate: cooked-echo-risk replies are written by the ingress with their
  // echo shapes armed; DA1/CPR stay on the host's own path, in call order.
  const hostWrite = (data: string): void => {
    if (ingress.answerLiveQueryReply(data)) {
      return
    }
    term.write(data)
  }

  let tail = ''
  let oscQueryCount = 0
  function answerQueriesInOrder(chunk: string): void {
    let buffer = tail + chunk
    tail = ''
    let index = 0
    while (index < buffer.length) {
      const at = buffer.indexOf('\x1b', index)
      if (at === -1) {
        return
      }
      const rest = buffer.slice(at)
      const grammar = QUERY_GRAMMARS.map((candidate) => ({
        candidate,
        match: candidate.re.exec(rest)
      })).find((entry) => entry.match)
      if (grammar?.match) {
        if (grammar.candidate === QUERY_GRAMMARS[0]) {
          oscQueryCount += 1
        }
        hostWrite(grammar.candidate.reply(grammar.match))
        index = at + grammar.match[0].length
        continue
      }
      if (PARTIAL_QUERY_RE.test(rest)) {
        tail = rest
        return
      }
      index = at + 1
    }
  }

  let exited = false
  term.onExit(() => {
    exited = true
  })
  term.onData((data) => ingress.accept(data))

  try {
    assert.equal(await waitUntil(() => rendered.includes(PROMPT_MARK), 15_000), true)
    await sleep(500)
    const oscQueriesBeforeHandoff = oscQueryCount

    // Type-ahead is the deterministic shape: queue the child's command while an
    // external command still owns the tty, so fish repaints its prompt (re-querying
    // OSC 11) and hands the tty over in the same breath.
    term.write('sleep 0.4\r')
    await sleep(150)
    term.write('"$ORCA_NODE_BIN" "$ORCA_CHILD_SCRIPT"\r')
    await sleep(1_500)
    assert.ok(oscQueryCount > oscQueriesBeforeHandoff)

    const renderedBeforeChildInput = rendered.length
    term.write('hello\r')
    assert.equal(
      await waitUntil(
        () => rendered.slice(renderedBeforeChildInput).includes('CHILD-READ:'),
        10_000
      ),
      true
    )

    const childRead =
      rendered.slice(renderedBeforeChildInput).match(/CHILD-READ:[^\r\n]*/)?.[0] ?? ''
    // The merge-blocking assertion: the child's first LINE is what the user typed,
    // with no escape byte in front of it. Pre-fix this reads
    // `\u001b]11;rgb:1e1e/1e1e/1e1e\u001b\\hello\n`.
    assert.equal(childRead, 'CHILD-READ:"hello\\n"')
  } finally {
    term.write('exit\r')
    await waitUntil(() => exited, 3_000)
    if (!exited) {
      term.kill()
    }
    assert.equal(await waitUntil(() => exited, 3_000), true)
    term.destroy()
  }
}
