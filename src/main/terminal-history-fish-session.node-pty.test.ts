// Fish writes history only interactively; answer terminal probes because no real xterm is attached.
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
        // Isolate HOME/XDG so the developer's fish config cannot make this pass.
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: home,
          TERM: 'xterm-256color',
          LANG: 'en_US.UTF-8',
          LC_ALL: 'en_US.UTF-8',
          XDG_CONFIG_HOME: home,
          XDG_DATA_HOME: dataHome,
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
      // Fish flushes history on exit; wait before reading.
      term.write('exit\r')
      expect(await waitUntil(() => exited, 10_000)).toBe(true)
      try {
        term.kill()
      } catch {
        // The child may already have exited.
      }

      const scopedPath = path.join(
        resolveFishHistoryDir({ XDG_DATA_HOME: dataHome }),
        `${session}_history`
      )
      expect(scopedPath).toBe(path.join(dataHome, 'fish', `${session}_history`))
      const scoped = readFileSync(scopedPath as string, 'utf8')
      expect(scoped).toContain(`- cmd: ${MARKER}`)
      expect(scoped).toMatch(/^ {2}when: \d+$/m)

      expect(() => readFileSync(path.join(dataHome, 'fish', 'fish_history'), 'utf8')).toThrow()
    },
    40_000
  )
})
