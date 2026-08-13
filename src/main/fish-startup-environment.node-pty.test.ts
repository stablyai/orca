/**
 * Real-fish coverage for the `-C` init command Orca hands every fish PTY.
 *
 * fish has no ZDOTDIR-style wrapper dir, so the only hook that runs AFTER the user's
 * config.fish is `--init-command`. Two things depend on it:
 *   - Orca's routed agent home must beat a `set -gx CODEX_HOME ...` in config.fish,
 *     or the account switcher silently launches the agent against the wrong account.
 *   - the attribution shim must be FIRST in PATH, or commits from fish panes lose the
 *     Orca trailer. macOS fish's bundled config.fish runs /usr/libexec/path_helper,
 *     which rebuilds PATH and demotes the inherited shim to near-last.
 *
 * Both are asserted against a control spawn with the init command removed, so a
 * regression that makes the init command a no-op cannot pass this file.
 *
 * Every path here is deliberately spacey (and one carries glob characters), because the
 * dirs this text moves around are really "~/Library/Application Support/...".
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getAttributionShellLaunchConfig } from './daemon/shell-ready'
import { getAttributionShellLaunchConfig as getLocalPtyAttributionShellLaunchConfig } from './providers/local-pty-shell-ready'
import { getFishInitCommand } from './shell-templates'
import { fishRequirementViolation, resolveFishBinary } from '../shared/fish-binary-requirement'

const FISH = resolveFishBinary()
const itWithFish = FISH.available ? it : it.skip

/** Minimal xterm-shaped answers to the probes fish blocks its first prompt on
 *  (~10s on the DA1 wait alone), so this suite settles in milliseconds. */
const TERMINAL_QUERY_REPLIES: readonly (readonly [string, string])[] = [
  ['\x1b[0c', '\x1b[?6c'],
  ['\x1b[?u', '\x1b[?0u'],
  ['\x1b[6n', '\x1b[1;1R'],
  ['\x1b]11;?', '\x1b]11;rgb:0000/0000/0000\x1b\\']
]
const QUERY_CARRY_LEN = Math.max(...TERMINAL_QUERY_REPLIES.map(([query]) => query.length))

// Spaces on purpose: "~/Library/Application Support/..." is the real shape of an Orca
// shim dir on macOS, and an unquoted fish `set` would silently split it into two entries.
const SHIM_DIR = '/orca test/attribution shim'
const TEAMS_SHIM_DIR = '/orca test/agent teams shim'
// Glob characters on purpose: fish treats an unmatched glob as a hard error, so a filter
// written with `string match` instead of a plain compare would take the whole init down.
const RELAY_SHIM_DIR = '/orca test/relay [cli] bin'
const USER_BIN_DIR = '/orca test/user bin'
const ORCA_CODEX_HOME = '/orca test/routed codex home'
const USER_CODEX_HOME = '/orca test/user codex home'
const SHELL_READY_MARKER = '\\033]777;orca-shell-ready\\007'

/**
 * fish single quotes are NOT POSIX single quotes: `\\` and `\'` still escape inside them,
 * and a trailing backslash before the closing quote is a syntax error. Verified on 4.7.1.
 */
function fishQuote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

/**
 * Spawns fish on a real PTY with the given args and returns what the session looks
 * like at its first prompt. Nothing is typed: a fish_prompt handler in config.fish
 * writes the answer to disk, so the result never races the line editor.
 */
async function readFirstPromptEnvironment(args: string[]): Promise<{
  pathFirstEntry: string
  codexHome: string
}> {
  const pty = await import('node-pty')
  const home = mkdtempSync(join(tmpdir(), 'orca fish startup '))
  const resultPath = join(home, 'probe-result')
  const donePath = join(home, 'probe-done')
  try {
    mkdirSync(join(home, '.config', 'fish'), { recursive: true })
    writeFileSync(
      join(home, '.config', 'fish', 'config.fish'),
      [
        'set -g fish_greeting ""',
        'function fish_prompt; printf "> "; end',
        'function fish_right_prompt; end',
        '# A user who routes their own agent home: Orca must still win.',
        `set -gx CODEX_HOME ${fishQuote(USER_CODEX_HOME)}`,
        '# Stands in for macOS path_helper (which really does run here on macOS):',
        '# whatever Orca prepended at spawn is no longer first once config.fish ran.',
        `set -gx PATH ${fishQuote(USER_BIN_DIR)} $PATH`,
        'function __orca_probe --on-event fish_prompt',
        `  echo "PATH1=$PATH[1]" >${fishQuote(resultPath)}`,
        `  echo "CODEX_HOME=$CODEX_HOME" >>${fishQuote(resultPath)}`,
        `  echo done >${fishQuote(donePath)}`,
        'end',
        ''
      ].join('\n')
    )

    const proc = pty.spawn(FISH.path as string, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: home,
      // Why fully specified and never spread from process.env: an inherited
      // ORCA_* or XDG_* from the developer's own shell would change the outcome.
      env: {
        // The inherited PATH only follows so the child can still resolve the fish
        // binary; both assertions read position 1, which is pinned here and then
        // displaced by config.fish, so no ambient entry can decide them.
        PATH: `${SHIM_DIR}:${process.env.PATH ?? '/usr/bin:/bin'}`,
        HOME: home,
        TERM: 'xterm-256color',
        XDG_CONFIG_HOME: join(home, '.config'),
        XDG_DATA_HOME: join(home, '.local', 'share'),
        ORCA_ATTRIBUTION_SHIM_DIR: SHIM_DIR,
        ORCA_CODEX_HOME
      }
    })

    let queryCarry = ''
    let settle = (): void => {}
    const done = new Promise<void>((resolve) => {
      settle = resolve
    })
    const deadline = setTimeout(settle, 15_000)
    const poll = setInterval(() => {
      if (existsSync(donePath)) {
        settle()
      }
    }, 25)
    proc.onData((chunk) => {
      // Why the carry: a query split across two chunks would otherwise go unanswered
      // and re-stall the prompt, while re-answering one already handled would land in
      // fish's stdin as typed input.
      const carriedLength = queryCarry.length
      const scan = queryCarry + chunk
      queryCarry = scan.slice(-QUERY_CARRY_LEN)
      for (const [query, reply] of TERMINAL_QUERY_REPLIES) {
        for (let at = scan.indexOf(query); at !== -1; at = scan.indexOf(query, at + query.length)) {
          if (at + query.length > carriedLength) {
            proc.write(reply)
          }
        }
      }
    })
    await done
    clearTimeout(deadline)
    clearInterval(poll)
    proc.kill()

    const result = existsSync(resultPath) ? readFileSync(resultPath, 'utf8') : ''
    return {
      pathFirstEntry: /^PATH1=(.*)$/m.exec(result)?.[1] ?? '',
      codexHome: /^CODEX_HOME=(.*)$/m.exec(result)?.[1] ?? ''
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

describe('fish startup environment', () => {
  // Always runs, so the CI lane cannot report green with the live tests skipped.
  it('has the fish this suite needs when CI requires one', () => {
    expect(fishRequirementViolation(FISH)).toBeNull()
  })

  it('hands both PTY transports the same fish attribution launch config', () => {
    // Why: the daemon and local-PTY copies drifted before; a fix landing in one
    // transport only is invisible until a user on the other one reports it.
    expect(getAttributionShellLaunchConfig('fish')).toEqual(
      getLocalPtyAttributionShellLaunchConfig('fish')
    )
  })

  itWithFish(
    'overrides a config.fish agent home and re-prepends the attribution shim',
    async () => {
      // Why the attribution config and not the shell-ready one: the markerless pane is
      // where a user types `git commit` by hand, and it got none of this before.
      const config = getAttributionShellLaunchConfig(FISH.path as string)
      expect(config.env.ORCA_SHELL_READY_MARKER).toBe('0')

      const withOrcaInit = await readFirstPromptEnvironment(config.args ?? [])
      // Control: same fish, same config.fish, no init command. Proves the two
      // assertions below are actually produced by the init command.
      const withoutOrcaInit = await readFirstPromptEnvironment(['-l'])

      expect(withOrcaInit.codexHome).toBe(ORCA_CODEX_HOME)
      expect(withoutOrcaInit.codexHome).toBe(USER_CODEX_HOME)

      expect(withOrcaInit.pathFirstEntry).toBe(SHIM_DIR)
      // Why the exact value and not `not.toBe(SHIM_DIR)`: a probe that never ran reads
      // as an empty string, which would satisfy a negative assertion for free.
      expect(withoutOrcaInit.pathFirstEntry).toBe(USER_BIN_DIR)
    },
    45_000
  )

  itWithFish('runs clean and unchanged when a pane re-runs it', () => {
    // Why: a re-initialized pane can evaluate this text a second time in the same
    // session. A plain prepend would grow PATH by one duplicate per shim per run.
    const home = mkdtempSync(join(tmpdir(), 'orca fish idempotent '))
    try {
      const initPath = join(home, 'init.fish')
      writeFileSync(initPath, getFishInitCommand(SHELL_READY_MARKER))
      const result = spawnSync(
        FISH.path as string,
        [
          // --no-config so the outcome is the init text alone, not a developer's config.fish.
          '--no-config',
          '-c',
          [
            'set -gx PATH /usr/bin /bin',
            `source ${fishQuote(initPath)}`,
            `source ${fishQuote(initPath)}`,
            'for __probe_entry in $PATH; echo "PATH=$__probe_entry"; end',
            'echo "CODEX_HOME=$CODEX_HOME"',
            // Nothing the init text declares may survive into the user's session.
            'echo "LEAKED=$__orca_shim_dir$__orca_kept_path$__orca_path_entry"'
          ].join('\n')
        ],
        {
          encoding: 'utf8',
          env: {
            PATH: process.env.PATH ?? '/usr/bin:/bin',
            HOME: home,
            // All three shim variables, because the duplication only shows up once a
            // later shim displaces an earlier one from PATH[1]. ORCA_REMOTE_CLI_BIN_DIR
            // is the relay's name for it and is only ever set on an SSH host.
            ORCA_ATTRIBUTION_SHIM_DIR: SHIM_DIR,
            ORCA_AGENT_TEAMS_SHIM_DIR: TEAMS_SHIM_DIR,
            ORCA_REMOTE_CLI_BIN_DIR: RELAY_SHIM_DIR,
            ORCA_CODEX_HOME,
            ORCA_SHELL_READY_MARKER: '0'
          }
        }
      )

      expect(result.stderr).toBe('')
      expect(result.status).toBe(0)
      const pathEntries = [...result.stdout.matchAll(/^PATH=(.*)$/gm)].map((match) => match[1])
      // Two `source`s, one entry each — and the relay shim ends up first, matching where
      // the relay's own bash/zsh wrappers put it.
      expect(pathEntries).toEqual([RELAY_SHIM_DIR, TEAMS_SHIM_DIR, SHIM_DIR, '/usr/bin', '/bin'])
      expect(result.stdout).toContain(`CODEX_HOME=${ORCA_CODEX_HOME}`)
      expect(result.stdout).toContain('LEAKED=\n')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
