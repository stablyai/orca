/**
 * Native writer probe for the Codex account restart (opt-in: ORCA_NATIVE_WRITER_PROBE=1).
 *
 * Runs the real terminal host and PTY spawner. A writer process appends a millisecond timestamp to
 * a file every 20ms; the probe issues the exact-incarnation fenced stop the restart uses and records
 * the outcome, whether writersExited was claimed, and any write that landed after the stop settled.
 * Each scenario prints one `writer-probe` JSON line (and appends it to ORCA_NATIVE_WRITER_PROBE_LOG
 * when set) so per-OS logs can be kept as evidence.
 */
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { TerminalHost } from '../terminal-host'
import { createPtySubprocess } from '../../pty-subprocess/pty-subprocess'
import type { PtyFencedTerminationOutcome } from '../../../../shared/terminal/pty/lifecycle/pty-fenced-termination'

const RUN_PROBE = process.env.ORCA_NATIVE_WRITER_PROBE === '1'
const WINDOWS = process.platform === 'win32'
const workDir = RUN_PROBE ? mkdtempSync(join(tmpdir(), 'orca-writer-probe-')) : ''

type Scenario = 'descendant-writer' | 'escaped-writer' | 'root-exits-first'

const POSIX_WRITER = `trap '' HUP TERM INT
echo $$ > "$1.pid"
while :; do perl -MTime::HiRes=time -e 'printf("%d\n", time*1000)' >> "$1"; sleep 0.02; done
`
const WINDOWS_WRITER = `param($file)
$PID | Out-File "$file.pid" -Encoding ascii
while ($true) { [DateTimeOffset]::Now.ToUnixTimeMilliseconds() | Out-File -Append -Encoding ascii $file; Start-Sleep -Milliseconds 20 }
`

// Each command leaves the session's root alive (except root-exits-first) while a writer appends.
function writerCommand(scenario: Scenario, file: string): string {
  if (WINDOWS) {
    const script = join(workDir, 'writer.ps1')
    writeFileSync(script, WINDOWS_WRITER)
    const start = `Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${script}','${file}'`
    if (scenario === 'escaped-writer') {
      // Started outside the PTY's job object, so it is not the session's descendant.
      return `${start}; Start-Sleep 600`
    }
    if (scenario === 'root-exits-first') {
      return `${start}; exit`
    }
    return `powershell -NoProfile -ExecutionPolicy Bypass -File '${script}' '${file}'`
  }
  const script = join(workDir, 'writer.sh')
  writeFileSync(script, POSIX_WRITER)
  if (scenario === 'escaped-writer') {
    // Double fork into a new session: the writer is no longer the root's descendant.
    return `(perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' sh '${script}' '${file}' >/dev/null 2>&1 &); sleep 600`
  }
  if (scenario === 'root-exits-first') {
    return `nohup sh '${script}' '${file}' >/dev/null 2>&1 & exit`
  }
  return `sh '${script}' '${file}' & wait`
}

function stopStrayWriter(file: string): void {
  try {
    const pid = Number(readFileSync(`${file}.pid`, 'utf8').trim())
    if (Number.isInteger(pid) && pid > 0) {
      process.kill(pid, 'SIGKILL')
    }
  } catch {
    // Already gone, or never started.
  }
}

function readWrites(file: string): number[] {
  if (!existsSync(file)) {
    return []
  }
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => Number(line.trim()))
    .filter((value) => Number.isFinite(value) && value > 0)
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return predicate()
}

async function probe(scenario: Scenario) {
  const file = join(workDir, `${scenario}.log`)
  const host = new TerminalHost({ spawnSubprocess: (opts) => createPtySubprocess(opts) })
  const sessionId = `writer-probe-${scenario}-${Date.now()}`
  const created = await host.createOrAttach({
    sessionId,
    cols: 80,
    rows: 24,
    cwd: workDir,
    command: writerCommand(scenario, file),
    ...(WINDOWS ? { shellOverride: 'powershell.exe' } : {}),
    launchAgent: 'codex',
    streamClient: { onData: () => {}, onExit: () => {} }
  })
  const writing = await waitFor(() => readWrites(file).length >= 5, 15_000)
  if (scenario === 'root-exits-first') {
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  const started = host.beginFencedTermination({
    id: sessionId,
    expectedIncarnationId: created.incarnationId,
    requireNoAgentOwner: true,
    requireUnattached: false
  })
  const outcome: PtyFencedTerminationOutcome = started.accepted
    ? await started.completion
    : started.result
  const settledAt = Date.now()
  await new Promise((resolve) => setTimeout(resolve, 1_500))
  const writes = readWrites(file)
  const writesAfterStop = writes.filter((at) => at > settledAt).length
  const record = {
    probe: 'writer-probe',
    platform: process.platform,
    arch: process.arch,
    scenario,
    writerStarted: writing,
    outcome,
    claimedWritersExited: outcome.outcome === 'ended' && outcome.writersExited === true,
    lastWriteMs: writes.at(-1) ?? null,
    settledAtMs: settledAt,
    writesAfterStop
  }
  console.log(JSON.stringify(record))
  if (process.env.ORCA_NATIVE_WRITER_PROBE_LOG) {
    appendFileSync(process.env.ORCA_NATIVE_WRITER_PROBE_LOG, `${JSON.stringify(record)}\n`)
  }
  stopStrayWriter(file)
  await host.dispose()
  return record
}

describe.skipIf(!RUN_PROBE)('native writer probe for account restart', () => {
  afterAll(() => {
    if (workDir) {
      // Windows can hold the stopped session's cwd handle briefly after exit.
      try {
        rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
      } catch (error) {
        console.warn('[writer-probe] could not remove', workDir, error)
      }
    }
  })

  it('a writer in the session tree is gone before the stop claims writersExited', async () => {
    const record = await probe('descendant-writer')
    expect(record.writerStarted).toBe(true)
    expect(record.claimedWritersExited).toBe(true)
    expect(record.writesAfterStop).toBe(0)
  }, 60_000)

  it('a root that already exited is never writer evidence', async () => {
    const record = await probe('root-exits-first')
    expect(record.claimedWritersExited).toBe(false)
  }, 60_000)

  // Recorded, not asserted: a process that left the session tree (new session, or outside the job
  // object) is invisible to the descendant scan, so writersExited does not cover it. Codex writes
  // its rollout from its own process, which is the root or a descendant.
  it('records a writer that escaped the session tree', async () => {
    const record = await probe('escaped-writer')
    expect(record.writerStarted).toBe(true)
  }, 60_000)
})
