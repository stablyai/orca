/** STA-2380 (C1 F1): Orca's zsh OSC 133;C hook runs first in `preexec_functions`, so a later user or
 * framework preexec hook prints before the agent exists. Real zsh under the production wrapper, a
 * silent stand-in `claude`, then the captured bytes replayed through the real tui-idle wait. */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as pty from 'node-pty'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { getShellLaunchConfig } from '../../../providers/local-pty/local-pty-shell-ready'
import { selectShellStartupFeatures } from '../../../pty/shell-startup/shell-startup-features'
import { hasZsh, ZSH_PATH } from '../../../pty/shell-startup/zsh-startup-hook-pty-harness'
import {
  createTranscriptPane,
  TRANSCRIPT_PANE_PTY_ID
} from '../../orca-runtime-tests/agent-transcript-pane-test-harness'
import { normalizeTerminalChunk } from '../output/terminal-ansi-normalization'
import { hasTerminalAgentPainted, TerminalCommandPaint } from '../input/terminal-command-paint'

const itWithZsh = hasZsh ? it : it.skip
const POLL_INTERVAL_MS = 2_000
const COMMAND_START = '\x1b]133;C'
// The stand-in's first bytes: Claude 2.1.310+ turns on palette-change reports before its composer.
const AGENT_FIRST_BYTES = '\x1b[?2031h'
const CLAUDE_COMPOSER_PROMPT = '❯ '
const CLAUDE_REST_TITLE = '✳ Claude Code'
/** Real silence between the shell handing off and the stand-in's first byte. */
const AGENT_SILENT_MS = 1_200

type HookCase = {
  name: string
  /** The user's .zshrc; `$ORCA_TEST_HOOK_ORDER` receives `preexec_functions` as the hook sees it. */
  zshrc: string
  hookName: string
  /** Whether bytes from the shell side alone satisfy the any-visible-byte paint latch. */
  anyBytePaintBeforeAgent: boolean
  /** Whether the stand-in sets Claude's own rest title; otherwise the pane keeps the hook's bare name. */
  agentSetsRestTitle: boolean
}

const RECORD_HOOK_ORDER = 'print -r -- "${preexec_functions[*]}" > "$ORCA_TEST_HOOK_ORDER"'

const HOOK_CASES: readonly HookCase[] = [
  {
    // oh-my-zsh lib/termsupport.zsh: `title` prints the window and tab titles, nothing visible.
    name: 'oh-my-zsh termsupport preexec (title-only)',
    zshrc: `autoload -Uz add-zsh-hook
_omz_termsupport_preexec() { ${RECORD_HOOK_ORDER}; print -Pn "\\e]2;claude\\a\\e]1;claude\\a" }
add-zsh-hook preexec _omz_termsupport_preexec
`,
    hookName: '_omz_termsupport_preexec',
    anyBytePaintBeforeAgent: false,
    agentSetsRestTitle: false
  },
  {
    // powerlevel10k's _p9k_preexec and starship (precmd only) print nothing at command start.
    name: 'powerlevel10k/starship-style preexec (silent)',
    zshrc: `autoload -Uz add-zsh-hook
_p9k_preexec() { ${RECORD_HOOK_ORDER}; typeset -g _P9K_TIMER_START=$EPOCHREALTIME }
add-zsh-hook preexec _p9k_preexec
`,
    hookName: '_p9k_preexec',
    anyBytePaintBeforeAgent: false,
    agentSetsRestTitle: true
  },
  {
    // zsh-you-should-use reminds about an alias from preexec: visible text after Orca's marker.
    name: 'zsh-you-should-use preexec (prints) under an oh-my-zsh title',
    zshrc: `autoload -Uz add-zsh-hook
_omz_termsupport_preexec() { print -Pn "\\e]2;claude\\a\\e]1;claude\\a" }
_ysu_preexec() { ${RECORD_HOOK_ORDER}; print -P '%F{yellow}Found existing alias for "claude". You should use: "cc".%f' }
add-zsh-hook preexec _omz_termsupport_preexec
add-zsh-hook preexec _ysu_preexec
`,
    hookName: '_ysu_preexec',
    anyBytePaintBeforeAgent: true,
    agentSetsRestTitle: false
  }
]

type Chunk = { data: string; at: number }

type Capture = { chunks: Chunk[]; hookOrder: string }

/** A `claude` that boots silently, then draws Claude's composer frame and waits for input. */
function standInClaude(setsRestTitle: boolean): string {
  const title = setsRestTitle ? `printf '\\033]0;${CLAUDE_REST_TITLE}\\007'\n` : ''
  return `#!/bin/sh
sleep ${AGENT_SILENT_MS / 1000}
printf '\\033[?2031h\\033[?2004h'
${title}printf '╭──────────╮\\r\\n│ ${CLAUDE_COMPOSER_PROMPT} │\\r\\n╰──────────╯\\033[?25h'
sleep 60
`
}

async function captureLaunch(hookCase: HookCase): Promise<Capture> {
  const root = mkdtempSync(join(tmpdir(), 'orca-preexec-order-'))
  const home = join(root, 'home')
  const bin = join(root, 'bin')
  mkdirSync(home)
  mkdirSync(bin)
  writeFileSync(join(home, '.zshrc'), hookCase.zshrc)
  const standIn = join(bin, 'claude')
  writeFileSync(standIn, standInClaude(hookCase.agentSetsRestTitle))
  chmodSync(standIn, 0o755)
  const hookOrderPath = join(root, 'hook-order.txt')

  // The production local launch: markers on, the agent command delivered from the first zle line.
  const features = selectShellStartupFeatures({
    shellPath: ZSH_PATH,
    env: { HOME: home },
    hasStartupCommand: true,
    waitsForShellReady: false,
    emitsStartupIdentity: false
  })
  const launch = getShellLaunchConfig(ZSH_PATH, features, 'claude')
  expect(launch.args, 'the zsh wrapper tree must be usable').not.toBeNull()
  // Resolve user config from the sandbox HOME only.
  const { ORCA_ORIG_ZDOTDIR: _dropped, ...launchEnv } = launch.env

  const proc = pty.spawn(ZSH_PATH, launch.args ?? ['-l'], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: home,
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: home,
      TERM: 'xterm-256color',
      LANG: 'en_US.UTF-8',
      ORCA_TEST_HOOK_ORDER: hookOrderPath,
      ...launchEnv
    }
  })
  const chunks: Chunk[] = []
  let output = ''
  const exited = new Promise<void>((resolve) => {
    proc.onExit(() => resolve())
  })
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no composer frame from the stand-in:\n${output}`)),
        25_000
      )
      proc.onData((data) => {
        chunks.push({ data, at: Date.now() })
        output += data
        if (output.includes(CLAUDE_COMPOSER_PROMPT)) {
          clearTimeout(timer)
          resolve()
        }
      })
      proc.onExit(() => {
        clearTimeout(timer)
        reject(new Error(`zsh exited before the stand-in painted:\n${output}`))
      })
    })
    return { chunks, hookOrder: readFileSync(hookOrderPath, 'utf8').trim() }
  } finally {
    try {
      proc.kill()
    } catch {
      // Already gone.
    }
    // zsh writes history and session files on the way out; remove the tree after it has gone.
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))])
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

/** The index of the stand-in's first chunk; everything before it is the shell and its hooks. */
function agentChunkIndex(chunks: readonly Chunk[]): number {
  const index = chunks.findIndex((chunk) => chunk.data.includes(AGENT_FIRST_BYTES))
  expect(index, 'the stand-in must have painted').toBeGreaterThan(0)
  return index
}

/** Feed captured bytes the way pty-output-ingestion does: normalized with the pending-escape carry. */
function observePaint(paint: TerminalCommandPaint, chunks: readonly Chunk[]): void {
  let pendingAnsi = ''
  for (const chunk of chunks) {
    const normalized = normalizeTerminalChunk(chunk.data, pendingAnsi)
    pendingAnsi = normalized.pendingAnsi
    paint.observe(chunk.data, normalized.text)
  }
}

describe.skipIf(process.platform === 'win32')('tui-idle under real zsh preexec hooks', () => {
  let userDataPath = ''
  let previousUserDataPath: string | undefined

  beforeAll(() => {
    previousUserDataPath = process.env.ORCA_USER_DATA_PATH
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-preexec-order-wrappers-'))
    process.env.ORCA_USER_DATA_PATH = userDataPath
  })

  afterAll(() => {
    if (previousUserDataPath === undefined) {
      delete process.env.ORCA_USER_DATA_PATH
    } else {
      process.env.ORCA_USER_DATA_PATH = previousUserDataPath
    }
    rmSync(userDataPath, { recursive: true, force: true })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe.each(HOOK_CASES)('$name', (hookCase) => {
    let capture: Capture

    beforeAll(async () => {
      capture = await captureLaunch(hookCase)
    }, 40_000)

    itWithZsh(
      "runs Orca's marker hook before the user hook, so hook output follows OSC 133;C",
      () => {
        expect(capture.hookOrder.split(/\s+/)[0]).toBe('__orca_osc133_preexec')
        expect(capture.hookOrder).toContain(hookCase.hookName)
        const agentIndex = agentChunkIndex(capture.chunks)
        const shellBytes = capture.chunks
          .slice(0, agentIndex)
          .map((chunk) => chunk.data)
          .join('')
        expect(shellBytes).toContain(COMMAND_START)
        // The stand-in stayed silent for a real interval after the shell handed off.
        const lastShellAt = capture.chunks[agentIndex - 1].at
        expect(capture.chunks[agentIndex].at - lastShellAt).toBeGreaterThanOrEqual(
          AGENT_SILENT_MS * 0.8
        )
      }
    )

    itWithZsh('attributes paint to Claude only once its own composer marker arrives', () => {
      const agentIndex = agentChunkIndex(capture.chunks)
      const paint = new TerminalCommandPaint()
      observePaint(paint, capture.chunks.slice(0, agentIndex))
      // The any-visible-byte latch is what C1 F1 found: hook text satisfies it before Claude runs.
      expect(paint.hasPainted()).toBe(hookCase.anyBytePaintBeforeAgent)
      expect(hasTerminalAgentPainted({ commandPaint: paint }, 'claude')).toBe(false)

      observePaint(paint, capture.chunks.slice(agentIndex))
      expect(hasTerminalAgentPainted({ commandPaint: paint }, 'claude')).toBe(true)
    })

    itWithZsh(
      'keeps `terminal wait --for tui-idle` pending through the silent boot, then settles on the composer',
      async () => {
        const agentIndex = agentChunkIndex(capture.chunks)
        const { runtime, handle } = await createTranscriptPane({
          paneTitle: 'Terminal',
          foregroundProcess: 'claude',
          launchAgent: 'claude',
          data: ''
        })
        vi.useFakeTimers()
        const replay = async (chunks: readonly Chunk[], previousAt: number): Promise<number> => {
          let at = previousAt
          for (const chunk of chunks) {
            await vi.advanceTimersByTimeAsync(Math.max(0, chunk.at - at))
            at = chunk.at
            runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, chunk.data, Date.now())
          }
          return at
        }

        const shellDoneAt = await replay(capture.chunks.slice(0, agentIndex), capture.chunks[0].at)
        const settled = vi.fn()
        const wait = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 60_000 })
        wait.then(settled, () => {})
        // A cold start slower than the capture: the shell's bytes are all the pane has for 12 s.
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 6)
        expect(settled).not.toHaveBeenCalled()

        await replay(capture.chunks.slice(agentIndex), shellDoneAt + POLL_INTERVAL_MS * 6)
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)
        await expect(wait).resolves.toMatchObject({ satisfied: true })
      }
    )
  })
})
