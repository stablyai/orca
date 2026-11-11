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
// The stand-in's first bytes: Claude turns on palette-change reports before its composer (captures
// from 2.1.291 through 2.1.316; no cutoff is claimed).
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
  /** Bytes only the user hook emits, to place it in the stream; null for a hook that prints nothing. */
  hookOutput: string | null
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
    agentSetsRestTitle: false,
    hookOutput: '\x1b]2;claude\x07'
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
    agentSetsRestTitle: true,
    hookOutput: null
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
    agentSetsRestTitle: false,
    hookOutput: 'Found existing alias for "claude"'
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
    // ast-grep-ignore: test-no-real-time-wait -- the condition is zsh's exit (`exited`); the cap only keeps a shell that ignores SIGHUP from stalling teardown, and rmSync retries cover a late writer.
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))])
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

type SplitCapture = {
  /** The shell and its hooks: every byte before the stand-in's first escape. */
  shell: Chunk[]
  /** The stand-in from its first byte on. A chunk that straddled the boundary is split, keeping its time. */
  agent: Chunk[]
}

/** Attribute bytes by their offset in the accumulated stream, not by PTY read boundaries: the anchor
 *  may arrive split across reads or coalesced with the shell's last bytes (C2 F2). */
function splitAtAgentStart(chunks: readonly Chunk[]): SplitCapture {
  const stream = chunks.map((chunk) => chunk.data).join('')
  const agentOffset = stream.indexOf(AGENT_FIRST_BYTES)
  expect(agentOffset, 'the stand-in must have painted').toBeGreaterThan(0)
  const shell: Chunk[] = []
  const agent: Chunk[] = []
  let offset = 0
  for (const chunk of chunks) {
    const end = offset + chunk.data.length
    if (end <= agentOffset) {
      shell.push(chunk)
    } else if (offset >= agentOffset) {
      agent.push(chunk)
    } else {
      const split = agentOffset - offset
      shell.push({ data: chunk.data.slice(0, split), at: chunk.at })
      agent.push({ data: chunk.data.slice(split), at: chunk.at })
    }
    offset = end
  }
  return { shell, agent }
}

/** The launch sequence as stream offsets over the joined bytes: Orca's command-start marker, then
 *  the user hook's output, then the agent's first byte and its composer. No assertion reads a PTY
 *  read boundary or a timestamp, so how the kernel chunked the stream cannot fail it (C3-1). */
function assertLaunchOrder(chunks: readonly Chunk[], hookCase: HookCase): void {
  const { shell, agent } = splitAtAgentStart(chunks)
  const shellBytes = shell.map((chunk) => chunk.data).join('')
  const agentBytes = agent.map((chunk) => chunk.data).join('')
  const commandStart = shellBytes.indexOf(COMMAND_START)
  expect(commandStart).toBeGreaterThanOrEqual(0)
  expect(shellBytes).not.toContain(AGENT_FIRST_BYTES)
  expect(agentBytes.startsWith(AGENT_FIRST_BYTES)).toBe(true)
  expect(agentBytes).toContain(CLAUDE_COMPOSER_PROMPT)
  if (hookCase.hookOutput !== null) {
    // The later hook printed after Orca's marker and before the agent existed: the C1 F1 shape.
    expect(shellBytes.indexOf(hookCase.hookOutput, commandStart)).toBeGreaterThan(commandStart)
  }
}

/** PTY read shapes a correct capture may arrive in; `agentOffset` is the anchor's stream offset. */
const RECHUNKINGS: readonly (readonly [
  string,
  (stream: string, agentOffset: number) => string[]
])[] = [
  ['coalesced into one read', (stream) => [stream]],
  [
    'split into 3-byte reads',
    (stream) =>
      Array.from({ length: Math.ceil(stream.length / 3) }, (_, i) => stream.slice(i * 3, i * 3 + 3))
  ],
  [
    'the anchor split across two reads',
    (stream, agentOffset) => [stream.slice(0, agentOffset + 3), stream.slice(agentOffset + 3)]
  ],
  [
    "the shell's last bytes and the agent's first output coalesced in one read",
    (stream, agentOffset) => {
      const joinEnd = agentOffset + AGENT_FIRST_BYTES.length + 4
      return [
        stream.slice(0, agentOffset - 4),
        stream.slice(agentOffset - 4, joinEnd),
        stream.slice(joinEnd)
      ]
    }
  ]
]

/** Feeds captured bytes the way pty-output-ingestion does: normalized, with the pending-escape carry
 *  kept across calls so an escape cut by a read boundary is not misread. */
function paintObserver(paint: TerminalCommandPaint): (chunks: readonly Chunk[]) => void {
  let pendingAnsi = ''
  return (chunks) => {
    for (const chunk of chunks) {
      const normalized = normalizeTerminalChunk(chunk.data, pendingAnsi)
      pendingAnsi = normalized.pendingAnsi
      paint.observe(chunk.data, normalized.text)
    }
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
        assertLaunchOrder(capture.chunks, hookCase)
      }
    )

    itWithZsh('attributes paint to Claude only once its own composer marker arrives', () => {
      const { shell, agent } = splitAtAgentStart(capture.chunks)
      const paint = new TerminalCommandPaint()
      const observe = paintObserver(paint)
      observe(shell)
      // The any-visible-byte latch is what C1 F1 found: hook text satisfies it before Claude runs.
      expect(paint.hasPainted()).toBe(hookCase.anyBytePaintBeforeAgent)
      expect(hasTerminalAgentPainted({ commandPaint: paint }, 'claude')).toBe(false)

      observe(agent)
      expect(hasTerminalAgentPainted({ commandPaint: paint }, 'claude')).toBe(true)
    })

    itWithZsh.each(RECHUNKINGS)(
      'attributes paint the same way with the capture %s',
      (_label, rechunk) => {
        const stream = capture.chunks.map((chunk) => chunk.data).join('')
        const agentOffset = stream.indexOf(AGENT_FIRST_BYTES)
        const at = capture.chunks[0].at
        const rechunked = rechunk(stream, agentOffset).map((data) => ({ data, at }))
        expect(rechunked.map((chunk) => chunk.data).join('')).toBe(stream)
        assertLaunchOrder(rechunked, hookCase)
        const { shell, agent } = splitAtAgentStart(rechunked)
        expect(shell.map((chunk) => chunk.data).join('')).toBe(stream.slice(0, agentOffset))
        expect(agent.map((chunk) => chunk.data).join('')).toBe(stream.slice(agentOffset))
        const paint = new TerminalCommandPaint()
        const observe = paintObserver(paint)
        observe(shell)
        expect(paint.hasPainted()).toBe(hookCase.anyBytePaintBeforeAgent)
        expect(hasTerminalAgentPainted({ commandPaint: paint }, 'claude')).toBe(false)
        observe(agent)
        expect(hasTerminalAgentPainted({ commandPaint: paint }, 'claude')).toBe(true)
      }
    )

    itWithZsh(
      'keeps `terminal wait --for tui-idle` pending through the silent boot, then settles on the composer',
      async () => {
        const { shell, agent } = splitAtAgentStart(capture.chunks)
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

        const shellDoneAt = await replay(shell, capture.chunks[0].at)
        const settled = vi.fn()
        const wait = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 60_000 })
        wait.then(settled, () => {})
        // A cold start slower than the capture: the shell's bytes are all the pane has for 12 s.
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 6)
        expect(settled).not.toHaveBeenCalled()

        await replay(agent, shellDoneAt + POLL_INTERVAL_MS * 6)
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)
        await expect(wait).resolves.toMatchObject({ satisfied: true })
      }
    )
  })
})
