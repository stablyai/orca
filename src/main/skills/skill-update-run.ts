import { spawn, type ChildProcess } from 'node:child_process'
import {
  canonicalizeSkillUpdateNames,
  type SkillUpdateRun,
  type SkillUpdateStartResult
} from '../../shared/skill-freshness'
import { resolveCliCommand } from '../codex-cli/command'
import { withCliRuntimeOnPath } from '../../shared/node-cli-command-resolution'
import { killWithDescendantSweep } from '../pty-descendant-termination'
import { getSpawnArgsForWindows, WINDOWS_BATCH_UNSAFE_CHARACTERS_LABEL } from '../win32-utils'

// Why: `skills update` prints ANSI colour and \r + erase-line progress. We show
// this log verbatim to the user but never parse it — `update` has no --json
// (that flag exists only on `list`), so stdout is not a contract.
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g // eslint-disable-line no-control-regex

// Keep the tail: failures land at the end, and an unbounded buffer would pin
// however much the CLI decides to print.
const MAX_OUTPUT_CHARS = 32_000

// Long enough to swallow a burst of progress frames, short enough that the log
// still reads as live when the user has it expanded.
const OUTPUT_FLUSH_MS = 100

// Strictly above the sweep's own transitive worst case (~1s on POSIX; 3s identity
// query + 5s taskkill on Windows). A backstop that ties its own bound would fire
// while a slow-but-healthy sweep is still working.
export const CANCEL_RELEASE_TIMEOUT_MS = 12_000

export type SkillUpdateRunnerDeps = {
  spawnProcess?: typeof spawn
  resolveCommand?: (commandName: string) => string
  /** Returns the subset of `names` that did not land, re-read from disk. */
  rescanOutdatedNames?: (names: string[]) => Promise<string[]>
  killTree?: (pid: number, killRoot: () => void) => Promise<void>
  /** Injected so the Windows cmd.exe rail is reachable off Windows. */
  buildSpawnArgs?: typeof getSpawnArgsForWindows
  now?: () => number
  onState?: (run: SkillUpdateRun) => void
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_RE, '').replace(/\r(?!\n)/g, '\n')
}

function clampOutput(value: string): string {
  return value.length <= MAX_OUTPUT_CHARS ? value : value.slice(value.length - MAX_OUTPUT_CHARS)
}

/**
 * Runs `npx --yes skills update <names> --global -y` headlessly.
 *
 * Both `--yes` flags are load-bearing and distinct: `npx --yes` skips the
 * install-this-package prompt, and `skills … -y` takes the CLI's own
 * non-interactive branch. `skills` gates its prompts on
 * `options.yes || !process.stdin.isTTY`, and stdin is ignored below, so the run
 * cannot block on input that no one can answer.
 */
export class SkillUpdateRunner {
  private run: SkillUpdateRun = { state: 'idle' }
  private child: ChildProcess | null = null
  // Why: a failed spawn emits `error` *and* `close`, and a cancelled child still
  // emits `close` after `kill()`. The token retires a child's handlers so a dead
  // run can never settle or write output into the run that replaced it; the latch
  // keeps the first verdict of a live run while its re-scan is still in flight.
  private runToken = 0
  private settling = false
  private killing = false
  private readonly deps: Required<Pick<SkillUpdateRunnerDeps, 'now'>> & SkillUpdateRunnerDeps

  constructor(deps: SkillUpdateRunnerDeps = {}) {
    this.deps = { now: () => Date.now(), ...deps }
  }

  getState(): SkillUpdateRun {
    return this.run
  }

  private publish(next: SkillUpdateRun): void {
    this.run = next
    this.deps.onState?.(next)
  }

  start(names: readonly string[]): SkillUpdateStartResult {
    if (this.run.state === 'running') {
      return { started: false, reason: 'already-running' }
    }
    const canonicalNames = canonicalizeSkillUpdateNames(names)
    if (!canonicalNames) {
      return { started: false, reason: 'invalid-names' }
    }

    const resolveCommand = this.deps.resolveCommand ?? ((name: string) => resolveCliCommand(name))
    const spawnProcess = this.deps.spawnProcess ?? spawn
    const npxCommand = resolveCommand('npx')
    const npxArgs = ['--yes', 'skills', 'update', ...canonicalNames, '--global', '-y']

    let spawnCmd: string
    let spawnArgs: string[]
    try {
      const buildSpawnArgs = this.deps.buildSpawnArgs ?? getSpawnArgsForWindows
      ;({ spawnCmd, spawnArgs } = buildSpawnArgs(npxCommand, npxArgs))
    } catch {
      // Why: the names are already canonical here, so this is the cmd.exe rail
      // rejecting the resolved npx *path*. Publishing the failure keeps the dialog
      // honest; a bare `started: false` would leave the button dead and silent.
      this.runToken += 1
      this.settling = false
      this.publish({
        state: 'error',
        names: canonicalNames,
        finishedAt: this.deps.now(),
        output: '',
        failedNames: canonicalNames,
        message:
          `Could not run ${npxCommand} safely from this location: its path contains one of ` +
          `${WINDOWS_BATCH_UNSAFE_CHARACTERS_LABEL}, which cmd.exe would reinterpret.`
      })
      return { started: false, reason: 'unsafe-command-path' }
    }

    const startedAt = this.deps.now()
    const token = ++this.runToken
    this.settling = false
    this.publish({ state: 'running', names: canonicalNames, startedAt, output: '' })

    const child = spawnProcess(spawnCmd, spawnArgs, {
      // Why: stdin ignored keeps `process.stdin.isTTY` falsy in the child, which
      // is the second half of the CLI's non-interactive gate.
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // Why: npx is an `#!/usr/bin/env node` script — without its own node ahead of
      // PATH it loads under whatever version leads, and a native dep dies on ABI.
      env: withCliRuntimeOnPath(npxCommand, { ...process.env })
    })
    this.child = child

    // Why: `stripAnsi` turns each \r progress frame into its own line, so an npm
    // install emits many chunks a second — and every publish structured-clones
    // the whole buffer to every window. Coalesce into one push per tick.
    let flushTimer: ReturnType<typeof setTimeout> | null = null
    let pendingOutput = ''
    const flush = (): void => {
      flushTimer = null
      if (token !== this.runToken || this.run.state !== 'running' || !pendingOutput) {
        return
      }
      const appended = pendingOutput
      pendingOutput = ''
      this.publish({ ...this.run, output: clampOutput(this.run.output + appended) })
    }
    const append = (chunk: Buffer): void => {
      if (token !== this.runToken || this.run.state !== 'running') {
        return
      }
      pendingOutput = clampOutput(pendingOutput + stripAnsi(chunk.toString('utf8')))
      if (!flushTimer) {
        flushTimer = setTimeout(flush, OUTPUT_FLUSH_MS)
        flushTimer.unref?.()
      }
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    // The tail matters most on failure, so never let a pending chunk die with the
    // process — drain it before the exit handlers settle the run.
    const drain = (): void => {
      if (flushTimer) {
        clearTimeout(flushTimer)
      }
      flush()
    }

    child.on('error', (error) => {
      drain()
      this.settle(token, canonicalNames, error.message)
    })
    child.on('close', (code) => {
      drain()
      this.settle(
        token,
        canonicalNames,
        code === 0 ? null : `skills update exited with code ${code}`
      )
    })

    return { started: true }
  }

  private settle(token: number, names: string[], spawnError: string | null): void {
    if (token !== this.runToken || this.settling || this.run.state !== 'running') {
      return
    }
    this.settling = true
    this.child = null
    const output = this.run.output
    const finishedAt = this.deps.now()
    const rescan = this.deps.rescanOutdatedNames

    // Why: when the re-scan produces a verdict it *is* the answer — it re-hashes
    // what landed on disk, which is what the user actually cares about. The exit
    // code only decides the outcome when no verdict is available, because
    // `skills update` reports nothing else we can trust.
    const finish = (failedNames: string[] | null): void => {
      // The re-scan is slow enough that a cancel — or a whole replacement run —
      // can land while it is still in flight; its verdict is about a run that no
      // longer exists.
      if (token !== this.runToken) {
        return
      }
      const failed = failedNames ?? (spawnError ? names : [])
      if (failed.length === 0) {
        this.publish({ state: 'success', names, finishedAt, output })
        return
      }
      this.publish({
        state: 'error',
        names,
        finishedAt,
        output,
        failedNames: failed,
        message: spawnError ?? 'Some skills could not be updated.'
      })
    }

    if (!rescan) {
      finish(null)
      return
    }
    void rescan(names).then(
      (failedNames) => finish(failedNames),
      () => finish(null)
    )
  }

  cancel(): void {
    if (this.killing) {
      return
    }
    // Retire the child's handlers now so its exit settles nothing.
    this.runToken += 1
    this.settling = false
    const child = this.child
    this.child = null
    if (!child) {
      if (this.run.state === 'running') {
        this.publish({ state: 'idle' })
      }
      return
    }

    // Why: `npx` is a wrapper — on POSIX the `skills` process it execs is a
    // child, and on Windows the shim runs under cmd.exe. Killing only the direct
    // child leaves the process that is actually writing to the global skill
    // homes alive.
    this.killing = true
    let hasReleased = false
    let releaseTimer: ReturnType<typeof setTimeout> | null = null
    const release = (): void => {
      if (hasReleased) {
        return
      }
      hasReleased = true
      if (releaseTimer) {
        clearTimeout(releaseTimer)
      }
      this.killing = false
      // Why: stay `running` until the tree is actually dead. The sweep waits for
      // a descendant snapshot before it signals anything, so releasing on the
      // synchronous path would let an immediate re-Update spawn a second npx
      // writing the same bundles — the corruption the post-run verdict exists to
      // catch. `start()` already refuses while running, so holding the state is
      // the whole guard.
      if (this.run.state === 'running') {
        this.publish({ state: 'idle' })
      }
    }
    // Every layer of the sweep is individually bounded, but this is the recovery
    // path: if one ever fails to settle, the run would be stuck `running` with
    // Stop already spent. Cap it rather than depend on that transitively.
    releaseTimer = setTimeout(release, CANCEL_RELEASE_TIMEOUT_MS)
    releaseTimer.unref?.()
    if (this.run.state === 'running') {
      this.publish({ ...this.run, stopping: true })
    }

    const kill = this.deps.killTree ?? killWithDescendantSweep
    const pid = child.pid
    if (typeof pid !== 'number') {
      // Same contract as the sweep path below: a throwing kill must not escape
      // and leave `killing` latched with the run stuck `running`.
      try {
        child.kill()
      } catch {
        /* already gone, or not ours to signal */
      }
      release()
      return
    }
    // Why `release` on both paths and no retry: the sweep runs `killRoot()` in its
    // own `finally`, so the only way it rejects is that kill throwing (EPERM) —
    // calling it again would throw straight back out of the rejection handler,
    // leaving an unhandled rejection and no release at all.
    void kill(pid, () => child.kill()).then(release, release)
  }

  /** Clears a settled run so the status-bar segment can retire itself. */
  acknowledge(): void {
    if (this.run.state === 'success' || this.run.state === 'error') {
      this.publish({ state: 'idle' })
    }
  }
}
