import { spawn } from 'child_process'
import { delimiter } from 'path'
import type { ShellHydrationFailureReason } from '../../shared/types'

// Why: GUI-launched Electron on macOS/Linux inherits a minimal PATH from launchd
// that does not include dirs appended by the user's shell rc files (~/.zshrc,
// ~/.bashrc). Tools installed into ~/.opencode/bin, ~/.cargo/bin, pyenv/volta
// shims, and countless other user-local locations end up invisible to our
// `which` probe even though they work fine from Terminal (see stablyai/orca#829).
//
// Rather than play whack-a-mole adding every agent's install dir to a hardcoded
// list, we spawn the user's login shell once per app session and read the PATH
// it would export. This matches the behavior of every popular Electron app that
// handles this problem (Hyper, VS Code, Cursor, etc. via shell-env/fix-path) —
// we implement it inline to avoid adding a dependency.

const DELIMITER = '__ORCA_SHELL_PATH__'
const SPAWN_TIMEOUT_MS = 5000

// ANSI escape sequences can leak into the captured output when the user's rc
// files print banners or set colored prompts. Strip them before parsing.
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g // eslint-disable-line no-control-regex

// Why: the discriminator lets telemetry classify *why* hydration failed, not
// just whether it did. Five resolve sites in this file each tag the result
// with the right reason. The shared alias keeps the enum in lockstep with the
// telemetry schema (compile-time guard in telemetry-events.ts).
export type HydrationResult =
  | { ok: true; segments: string[]; failureReason: 'none' }
  | {
      ok: false
      segments: []
      failureReason: Exclude<ShellHydrationFailureReason, 'none'>
    }

let cached: Promise<HydrationResult> | null = null

/** @internal - tests need a clean hydration cache between cases. */
export function _resetHydrateShellPathCache(): void {
  cached = null
}

function pickShell(): string | null {
  if (process.platform === 'win32') {
    return null
  }
  const shell = process.env.SHELL
  if (shell && shell.length > 0) {
    return shell
  }
  return process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'
}

function parseCapturedPath(stdout: string): string[] {
  const cleaned = stdout.replace(ANSI_RE, '')
  const first = cleaned.indexOf(DELIMITER)
  if (first < 0) {
    return []
  }
  const second = cleaned.indexOf(DELIMITER, first + DELIMITER.length)
  if (second < 0) {
    return []
  }
  const value = cleaned.slice(first + DELIMITER.length, second).trim()
  if (!value) {
    return []
  }
  // Why: Set preserves insertion order, and PATH resolution is first-match-wins,
  // so de-duping this way keeps the user's rc-file ordering intact.
  return [
    ...new Set(
      value
        .split(delimiter)
        .map((s) => s.trim())
        .filter(Boolean)
    )
  ]
}

function spawnShellAndReadPath(shell: string): Promise<HydrationResult> {
  return new Promise((resolve) => {
    // Why: printing $PATH between delimiters is resilient to rc-file banners,
    // MOTDs, and `echo` invocations that shells like fish print unprompted.
    // `-ilc` runs the shell as a login+interactive so both .profile/.zprofile
    // and .bashrc/.zshrc are sourced — matches what `which` in Terminal sees.
    const command = `printf '%s' '${DELIMITER}'; printf '%s' "$PATH"; printf '%s' '${DELIMITER}'`
    let finished = false
    let stdout = ''

    const child = spawn(shell, ['-ilc', command], {
      // Why: inherit current env so the shell sees the same baseline, then let
      // it layer its own rc files on top. Do NOT forward stdio — some shells
      // (oh-my-zsh setups, powerlevel10k) print a lot to stderr on startup,
      // and we don't want that in Orca's console.
      env: process.env,
      stdio: ['ignore', 'pipe', 'ignore'],
      detached: false
    })

    const timer = setTimeout(() => {
      if (finished) {
        return
      }
      finished = true
      // Why: slow rc files (corporate env setup, nvm eager init) can exceed
      // our budget. Kill the shell and fall back to process.env rather than
      // blocking the Agents pane indefinitely.
      try {
        child.kill('SIGKILL')
      } catch {
        // ignore
      }
      resolve({ segments: [], ok: false, failureReason: 'timeout' })
    }, SPAWN_TIMEOUT_MS)

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })

    child.on('error', () => {
      if (finished) {
        return
      }
      finished = true
      clearTimeout(timer)
      resolve({ segments: [], ok: false, failureReason: 'spawn_error' })
    })

    child.on('close', () => {
      if (finished) {
        return
      }
      finished = true
      clearTimeout(timer)
      const segments = parseCapturedPath(stdout)
      if (segments.length === 0) {
        resolve({ segments: [], ok: false, failureReason: 'empty_path' })
        return
      }
      resolve({ segments, ok: true, failureReason: 'none' })
    })
  })
}

type HydrateOptions = {
  force?: boolean
  /** Override for tests — defaults to running `spawn` against the real shell. */
  spawner?: (shell: string) => Promise<HydrationResult>
  /** Override for tests — defaults to `pickShell()`. */
  shellOverride?: string | null
}

/**
 * Spawn the user's login shell once and return the PATH it would export.
 * Caches the promise for the lifetime of the process — call
 * `_resetHydrateShellPathCache()` in tests or `hydrateShellPath({ force: true })`
 * when the user asks to re-probe (e.g. after installing a new CLI).
 */
export function hydrateShellPath(options: HydrateOptions = {}): Promise<HydrationResult> {
  if (cached && !options.force) {
    return cached
  }
  const shell = options.shellOverride !== undefined ? options.shellOverride : pickShell()
  if (!shell) {
    // Windows uses cmd/PowerShell rather than a POSIX login shell — the
    // `patchPackagedProcessPath` static list is sufficient there.
    cached = Promise.resolve({ segments: [], ok: false, failureReason: 'no_shell' })
    return cached
  }
  cached = (options.spawner ?? spawnShellAndReadPath)(shell)
  return cached
}

/**
 * Prepend newly-discovered PATH segments to process.env.PATH, preserving
 * existing ordering and avoiding duplicates. Returns the segments that were
 * actually added so callers can log/telemetry on nontrivial hydrations.
 */
export function mergePathSegments(segments: string[]): string[] {
  if (segments.length === 0) {
    return []
  }
  const current = process.env.PATH ?? ''
  const existing = new Set(current.split(delimiter).filter(Boolean))
  // Why: Node 22+ Set.prototype.difference preserves insertion order of the
  // receiver, so [...incoming.difference(existing)] gives us the new entries
  // in the order the shell provided them (first-match-wins on PATH).
  const added = [...new Set(segments).difference(existing)]
  if (added.length === 0) {
    return []
  }
  // Why: prepend so shell-provided entries win over the hardcoded fallbacks.
  // The user's rc files are the source of truth for `which`-style resolution.
  process.env.PATH = [...added, ...current.split(delimiter).filter(Boolean)].join(delimiter)
  return added
}
