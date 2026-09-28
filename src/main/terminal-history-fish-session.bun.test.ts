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
import { runBundledBunFixture } from './bundled-bun-test-execution'
import { fishHistorySessionName, resolveFishHistoryDir } from './fish-history-session'

const FISH = resolveFishBinary(4)
const itWithFish = FISH.available ? it : it.skip

const PROMPT_MARK = 'ORCAHIST> '
const WORKTREE_HASH = 'deadbeefdeadbeef'
const MARKER = 'echo orca-worktree-scoped-history'

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
      if (!FISH.path) {
        throw new Error('Fish binary missing')
      }
      await runBundledBunFixture(
        path.join(__dirname, 'terminal-history-fish-session-bun-fixture.ts'),
        'runFishHistoryFixture',
        { binary: FISH.path, home, dataHome, session, promptMark: PROMPT_MARK, marker: MARKER },
        35_000
      )

      const scopedPath = path.join(
        resolveFishHistoryDir({ XDG_DATA_HOME: dataHome }),
        `${session}_history`
      )
      expect(scopedPath).toBe(path.join(dataHome, 'fish', `${session}_history`))
      const scoped = readFileSync(scopedPath, 'utf8')
      // YAML-ish records, not one line per command — any reader must handle this shape.
      expect(scoped).toContain(`- cmd: ${MARKER}`)
      expect(scoped).toMatch(/^ {2}when: \d+$/m)

      // Isolation: the default session file fish would otherwise have used is absent.
      expect(() => readFileSync(path.join(dataHome, 'fish', 'fish_history'), 'utf8')).toThrow()
    },
    40_000
  )
})
