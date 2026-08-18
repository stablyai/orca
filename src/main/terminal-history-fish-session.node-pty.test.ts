/**
 * Real-fish proof for worktree-scoped fish history.
 *
 * fish IGNORES HISTFILE, so the directory+filename mechanism bash and zsh use does
 * not transfer: history lives at `$XDG_DATA_HOME/fish/${fish_history}_history` and
 * the only isolation knob is the session NAME. This suite pins the two facts
 * `injectHistoryEnv` bets on — that fish picks up `fish_history` from the spawn
 * environment (it imports env vars as global variables at startup), and that the
 * file it then writes is the one `resolveFishHistoryDir` points at.
 *
 * Interactive is mandatory: fish writes no history in non-interactive mode, so the
 * PTY and the typed line are the test, not scaffolding. DA1/CPR/OSC-11 probes are
 * answered here because no real xterm is attached — without them fish stalls ~10s
 * on its DA1 read sentinel before painting a prompt.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fishRequirementViolation, resolveFishBinary } from '../shared/fish-binary-requirement'
import { fishHistorySessionName, resolveFishHistoryDir } from './fish-history-session'

const FISH = resolveFishBinary(4)
const itWithFish = FISH.available ? it : it.skip

const PROMPT_MARK = 'ORCAHIST> '
const WORKTREE_HASH = 'deadbeefdeadbeef'
const MARKER = 'echo orca-worktree-scoped-history'

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

describe('fish keeps per-worktree history under the session Orca names', () => {
  let home: string | null = null

  // Always runs, so the CI lane cannot report green with the regression below skipped.
  it('has the fish this suite needs when CI requires one', () => {
    expect(fishRequirementViolation(FISH)).toBeNull()
  })

  afterEach(() => {
    if (home) {
      rmSync(home, { recursive: true, force: true })
      home = null
    }
  })

  itWithFish(
    'writes an interactive command to $XDG_DATA_HOME/fish/<session>_history, not the shared file',
    async () => {
      const nodePty = await import('node-pty')

      home = mkdtempSync(path.join(tmpdir(), 'orca-fish-history-'))
      const dataHome = path.join(home, 'data')
      mkdirSync(path.join(home, 'fish'), { recursive: true })
      writeFileSync(
        path.join(home, 'fish/config.fish'),
        [
          'set -g fish_greeting ""',
          `function fish_prompt; printf '${PROMPT_MARK}'; end`,
          'function fish_right_prompt; end',
          ''
        ].join('\n')
      )

      const session = fishHistorySessionName(WORKTREE_HASH)
      const term = nodePty.spawn(FISH.path as string, ['-l', '-i'], {
        name: 'xterm-256color',
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

      expect(await waitUntil(() => rendered.includes(PROMPT_MARK), 15_000)).toBe(true)
      term.write(`${MARKER}\r`)
      expect(await waitUntil(() => rendered.includes('orca-worktree-scoped-history'), 5_000)).toBe(
        true
      )
      // fish flushes history on exit, so the read must wait for the process to go.
      term.write('exit\r')
      expect(await waitUntil(() => exited, 10_000)).toBe(true)
      try {
        term.kill()
      } catch {
        // already gone
      }

      const scopedPath = path.join(
        resolveFishHistoryDir({ XDG_DATA_HOME: dataHome }),
        `${session}_history`
      )
      expect(scopedPath).toBe(path.join(dataHome, 'fish', `${session}_history`))
      const scoped = readFileSync(scopedPath as string, 'utf8')
      // YAML-ish records, not one line per command — any reader must handle this shape.
      expect(scoped).toContain(`- cmd: ${MARKER}`)
      expect(scoped).toMatch(/^ {2}when: \d+$/m)

      // Isolation: the default session file fish would otherwise have used is absent.
      expect(() => readFileSync(path.join(dataHome, 'fish', 'fish_history'), 'utf8')).toThrow()
    },
    40_000
  )
})
