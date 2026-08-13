import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The evidence module decides whether a daemon still hosts user terminals by looking at its
 * process tree, and must discount the PTYs the daemon opens for itself. That exclusion list
 * is only safe while it is complete — a self-spawned PTY nobody excluded reads as user work
 * and holds a daemon that owns nothing, which is how the list grew a reviewer at a time.
 *
 * So pin the input instead of the list: every PTY the daemon opens *directly*, enumerated
 * from the source. A new spawn site fails this test until someone decides which side it
 * belongs on.
 *
 * Scope, stated so the next reader does not over-trust it: this sees node-pty calls in this
 * directory only. The daemon can also open a PTY through a helper binary — the macOS login
 * session probe shells out to `expect`, whose own `spawn` forkpty's a `login` wrapper that
 * surfaces as a session-leader grandchild (`macos-login-session-pty-probe.ts`). That one is
 * caught by the stranded-wrapper filter rather than by this list, and it is the shape a
 * future escape will take: indirect, and outside this directory.
 */
const KNOWN_DAEMON_PTY_SPAWN_SITES = [
  // The user's terminal — the thing the evidence exists to protect.
  { file: 'pty-subprocess.ts', argv: 'wrapped.file, wrapped.args', hosted: true },
  // checkPtySpawnHealth
  { file: 'pty-subprocess.ts', argv: "'/bin/sh', ['-c', 'exit 0']", hosted: false },
  // warmWindowsConptyOnce
  { file: 'windows-conpty-warmup.ts', argv: "COMSPEC || 'cmd.exe', ['/c', 'exit']", hosted: false }
]

describe('daemon self-spawned PTY inventory', () => {
  it('has no PTY spawn site the ownership evidence has not accounted for', () => {
    const daemonDir = join(import.meta.dirname)
    const sites = readdirSync(daemonDir)
      .filter((name) => name.endsWith('.ts') && !name.includes('.test.'))
      .flatMap((name) => {
        const source = readFileSync(join(daemonDir, name), 'utf8')
        return [...source.matchAll(/(?:pty\.spawn|spawnPty)\s*\(/g)]
          .filter((match) => !/typeof pty\.spawn/.test(source.slice(match.index - 80, match.index)))
          .map(() => name)
      })

    expect(sites.sort()).toEqual(KNOWN_DAEMON_PTY_SPAWN_SITES.map((site) => site.file).sort())
  })
})
