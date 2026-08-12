/**
 * Real-PTY reproduction for #13642.
 *
 * The daemon holds a startup command behind the `orca-shell-ready` marker. When a shell reaches
 * its first prompt after the shell-ready deadline, the pre-fix delivery path (`session.write`)
 * released the command into a PTY whose shell was not reading yet, and the launch was lost with
 * no error anywhere.
 *
 * Nothing here is mocked: the daemon's own `createPtySubprocess` spawns a real shell process on a
 * real PTY, real timers run, and the two delivery paths — the pre-fix `write` and the fix's
 * `writeStartupCommand` — drive that same session. The injected shell-ready timeout is short so
 * the marker is late by construction rather than by luck.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPtySubprocess } from './pty-subprocess'
import { Session } from './session'

const SHELL_READY_TIMEOUT_MS = 250
const LATE_MARKER_GRACE_MS = 20_000
// Why 20 reads of up to 100ms each: the fixture shell must still be discarding input when the
// deadline flush fires, however late a loaded machine runs that timer. The window only ever
// grows under load, never shrinks below the injected timeout.
const DISCARD_READS = 20
const WAIT_TIMEOUT_MS = 25_000

/** A shell that reaches its first prompt long after the shell-ready deadline.
 *
 * Why the drain: a shell whose line editor takes the terminal with tcsetattr(TCSAFLUSH) throws
 * away everything typed before it got there, and that discard is the reason the shell-ready
 * barrier exists. The fixture reproduces it with an explicit non-canonical drain so the window is
 * bounded by the fixture rather than by the host's shell version. The `buffer` mode covers the
 * other kind of shell, which keeps typeahead — there the fix must still deliver exactly once. */
function getFixtureShellScript(): string {
  return `#!/bin/bash
if [ "\${ORCA_REPRO_13642_TYPEAHEAD:-discard}" = "buffer" ]; then
  sleep "\${ORCA_REPRO_13642_BUFFER_SECONDS:-2}"
else
  stty -icanon min 0 time 1
  reads=0
  while [ "$reads" -lt "\${ORCA_REPRO_13642_DISCARD_READS:-1}" ]; do
    dd of=/dev/null bs=65536 count=1 2>/dev/null
    reads=$((reads + 1))
  done
  stty icanon
fi
if [ -n "\${ORCA_REPRO_13642_EXIT_BEFORE_MARKER:-}" ]; then
  exit 3
fi
printf '\\033]777;orca-shell-ready\\007'
printf 'fixture $ '
while IFS= read -r line; do
  printf 'RAN:%s\\n' "$line"
done
`
}

type StartupDelivery = 'pre-fix-write' | 'startup-command'

type LateMarkerRun = {
  startupRuns: number
  sentinelRuns: number
  output: string
  shellState: string
}

const describeOnPosix = process.platform === 'win32' ? describe.skip : describe

describeOnPosix('#13642 startup command across a late shell-ready marker (real PTY)', () => {
  let fixtureDir: string
  let fixtureShellPath: string

  beforeAll(() => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'orca-repro-13642-'))
    fixtureShellPath = join(fixtureDir, 'late-prompt-shell.sh')
    writeFileSync(fixtureShellPath, getFixtureShellScript())
    chmodSync(fixtureShellPath, 0o755)
  })

  afterAll(() => {
    rmSync(fixtureDir, { recursive: true, force: true })
  })

  async function waitUntil(predicate: () => boolean, description: string): Promise<void> {
    const deadline = Date.now() + WAIT_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (predicate()) {
        return
      }
      await delay(10)
    }
    throw new Error(`Timed out waiting for ${description}`)
  }

  function countOccurrences(haystack: string, needle: string): number {
    return haystack.split(needle).length - 1
  }

  function createLateMarkerSession(token: string, extraEnv: Record<string, string> = {}) {
    const sessionId = `repro-13642-${token}`
    const subprocess = createPtySubprocess({
      sessionId,
      cols: 80,
      rows: 24,
      cwd: fixtureDir,
      shellOverride: fixtureShellPath,
      env: { ORCA_REPRO_13642_DISCARD_READS: String(DISCARD_READS), ...extraEnv },
      // Why: an Orca shim inherited from the developer's own shell would rewrite the fixture's
      // launch args; drop them so the spawn is the same on every machine.
      envToDelete: [
        'ORCA_ATTRIBUTION_SHIM_DIR',
        'ORCA_OPENCODE_CONFIG_DIR',
        'ORCA_MIMOCODE_HOME',
        'ORCA_OMP_STATUS_EXTENSION',
        'ORCA_CODEX_HOME',
        'ORCA_AGENT_TEAMS_SHIM_DIR'
      ]
    })
    const chunks: string[] = []
    const session = new Session({
      sessionId,
      cols: 80,
      rows: 24,
      subprocess,
      shellReadySupported: true,
      shellReadyTimeoutMs: SHELL_READY_TIMEOUT_MS,
      shellReadyLateMarkerGraceMs: LATE_MARKER_GRACE_MS
    })
    let exited = false
    session.attachClient({
      onData: (data) => chunks.push(data),
      onExit: () => {
        exited = true
      }
    })
    return {
      session,
      output: () => chunks.join(''),
      hasExited: () => exited,
      dispose: () => {
        session.dispose()
        subprocess.kill()
      }
    }
  }

  function deliverStartupCommand(
    session: Session,
    delivery: StartupDelivery,
    command: string
  ): void {
    if (delivery === 'pre-fix-write') {
      // The literal pre-fix call site: terminal-host-session-create.ts wrote the startup command
      // with session.write() before this change.
      session.write(command)
      return
    }
    // Why the lookup instead of a direct call: reverting the fix removes writeStartupCommand, and
    // the harness must then fail on the delivery assertion below, not on a TypeError.
    const writeStartupCommand = (session as Partial<Session>).writeStartupCommand
    if (typeof writeStartupCommand === 'function') {
      writeStartupCommand.call(session, command)
      return
    }
    session.write(command)
  }

  async function runLateMarkerDelivery(
    delivery: StartupDelivery,
    token: string,
    extraEnv: Record<string, string> = {}
  ): Promise<LateMarkerRun> {
    const harness = createLateMarkerSession(token, extraEnv)
    const startupCommand = `startup-${token}`
    const sentinel = `sentinel-${token}`
    try {
      deliverStartupCommand(harness.session, delivery, `${startupCommand}\n`)

      // The boundary itself: the deadline expires while the shell is still discarding input.
      await waitUntil(
        () => harness.session.shellState === 'timed_out',
        'the injected shell-ready deadline to expire before the marker'
      )
      expect(harness.output()).not.toContain(`RAN:${startupCommand}`)

      // Pre-fix, a session that already timed out stops scanning, so the late marker never flips
      // it to 'ready' — wait on the marker bytes reaching the pane instead.
      await waitUntil(
        () =>
          harness.session.shellState === 'ready' ||
          harness.output().includes('orca-shell-ready') ||
          harness.hasExited(),
        'the late shell-ready marker'
      )

      // A keystroke behind the startup command: once the shell echoes it back, anything the
      // session delivered earlier has already been read, so nothing is merely still in flight.
      harness.session.write(`${sentinel}\n`)
      await waitUntil(
        () => harness.output().includes(`RAN:${sentinel}`),
        'the shell to run the sentinel keystroke'
      )

      const output = harness.output()
      return {
        startupRuns: countOccurrences(output, `RAN:${startupCommand}`),
        sentinelRuns: countOccurrences(output, `RAN:${sentinel}`),
        output,
        shellState: harness.session.shellState
      }
    } finally {
      harness.dispose()
    }
  }

  it('loses the startup command when the pre-fix path releases it at the deadline', async () => {
    const run = await runLateMarkerDelivery('pre-fix-write', 'prefix')

    // The shell is alive and reading — it ran the later keystroke — but the launch is gone.
    expect(run.sentinelRuns).toBe(1)
    expect(run.startupRuns).toBe(0)
  })

  it('delivers the startup command exactly once when the marker arrives late', async () => {
    const run = await runLateMarkerDelivery('startup-command', 'fixed')

    expect(run.startupRuns).toBe(1)
    expect(run.sentinelRuns).toBe(1)
    expect(run.shellState).toBe('ready')
    // Held until the marker, so it lands ahead of input typed after the shell was ready.
    expect(run.output.indexOf('RAN:startup-fixed')).toBeLessThan(
      run.output.indexOf('RAN:sentinel-fixed')
    )
  })

  // Why: a re-delivery that fired on both the deadline and the marker would launch an agent twice.
  it('still delivers exactly once when the late shell buffered typeahead instead', async () => {
    const run = await runLateMarkerDelivery('startup-command', 'buffered', {
      ORCA_REPRO_13642_TYPEAHEAD: 'buffer'
    })

    expect(run.startupRuns).toBe(1)
    expect(run.sentinelRuns).toBe(1)
  })

  it('reports the startup command a shell exited before ever reading', async () => {
    const harness = createLateMarkerSession('exit', { ORCA_REPRO_13642_EXIT_BEFORE_MARKER: '1' })
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '))
    }
    try {
      deliverStartupCommand(harness.session, 'startup-command', 'startup-exit\n')
      await waitUntil(() => harness.hasExited(), 'the fixture shell to exit without a marker')

      expect(harness.output()).not.toContain('RAN:startup-exit')
      expect(warnings.some((line) => line.includes('never delivered'))).toBe(true)
    } finally {
      console.warn = originalWarn
      harness.dispose()
    }
  })
})
