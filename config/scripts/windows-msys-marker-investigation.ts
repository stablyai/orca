import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync, writeSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { spawn, type IPty } from 'node-pty'
import { resolveGitBashPath } from '../../src/main/git-bash'
import {
  assignHostProcessToKillOnCloseJob,
  listPtyJobProcessIds,
  terminatePtyJob
} from '../../src/main/windows/windows-pty-job'
import { quotePosixShell } from '../../src/shared/wsl-login-shell-command'
import { removeTreeSync } from '../../src/shared/windows-transient-lock-removal'

const started = performance.now()
const requireFromWorkspace = createRequire(join(process.cwd(), 'package.json'))
const sampleId = process.env.ORCA_INVESTIGATION_SAMPLE ?? 'unknown'
const variant = process.env.ORCA_INVESTIGATION_VARIANT ?? 'unknown'

export function report(phase: string, details: Record<string, unknown> = {}): void {
  writeSync(
    1,
    `${JSON.stringify({ phase, sampleId, variant, hostPid: process.pid, elapsedMs: Math.round(performance.now() - started), ...details })}\n`
  )
}

export function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      if (error.code === 'ESRCH') {
        return false
      }
      if (error.code === 'EPERM') {
        return true
      }
    }
    throw error
  }
}

export async function runMsysCase(mode: string): Promise<void> {
  assert.ok(['original', 'control', 'ready'].includes(mode), 'Unknown case mode')
  assert.equal(process.platform, 'win32', 'Real Windows ConPTY is required')
  const nodePtyRoot = dirname(requireFromWorkspace.resolve('node-pty/package.json'))
  const addonPath = join(nodePtyRoot, 'build', 'Release', 'conpty.node')
  report('native', {
    mode,
    addonPath,
    addonSha256: hashFile(addonPath),
    sourceSha256: hashFile(join(nodePtyRoot, 'src', 'win', 'conpty.cc')),
    patchSha256: hashFile(join(process.cwd(), 'config', 'patches', 'node-pty@1.1.0.patch')),
    node: process.version,
    inheritedBashEnv: Boolean(process.env.BASH_ENV)
  })
  requireFromWorkspace(addonPath)
  assert.equal(assignHostProcessToKillOnCloseJob(), true, 'Crash cleanup requires a host job')
  const shell = resolveGitBashPath()
  assert.ok(shell, 'Git for Windows must be installed')
  const directory = mkdtempSync(join(tmpdir(), 'orca-msys-investigation-'))
  const script = join(directory, 'owned-child.js')
  writeFileSync(
    script,
    "console.log('MSYS_OWNED_CHILD=' + process.pid); setInterval(() => {}, 1000)\n"
  )
  const prompt = `ORCA_MSYS_READY_${randomBytes(6).toString('hex')}> `
  const startup = join(directory, 'prompt-env.sh')
  // Noninteractive Bash discards inherited PS1; both instrumented cases re-export it here.
  writeFileSync(startup, `export PS1=${quotePosixShell(prompt)}\n`)
  const env =
    mode === 'original'
      ? process.env
      : {
          ...process.env,
          BASH_ENV: startup.replace(/\\/g, '/'),
          PS1: prompt
        }
  let proc: IPty | undefined
  let output = ''
  let outputBytes = 0
  let outputCodeUnits = 0
  let streamedCodeUnits = 0
  let childPid: number | undefined
  let exit: { exitCode: number; signal?: number } | undefined
  let phase = 'spawn'
  let resolveExit = () => {}
  const exited = new Promise<void>((resolvePromise) => {
    resolveExit = resolvePromise
  })
  const failures: unknown[] = []
  const spawnStarted = performance.now()
  const markerDeadline = spawnStarted + 15_000
  const evidence = () => ({
    mode,
    stage: phase,
    shell,
    shellPid: proc?.pid,
    childPid,
    exit,
    jobPids: proc ? listPtyJobProcessIds(proc) : null,
    elapsedSinceSpawnMs: Math.round(performance.now() - spawnStarted),
    markerDeadlineMs: 15_000,
    output,
    outputBytes,
    transcriptTruncated: outputCodeUnits > 32_768
  })
  async function observe(label: string, predicate: () => boolean, deadline: number): Promise<void> {
    phase = label
    for (;;) {
      assert.ok(performance.now() <= deadline, `${label} exceeded its deadline`)
      if (predicate()) {
        return
      }
      assert.equal(exit, undefined, `Shell exited during ${label}`)
      await delay(Math.min(25, Math.max(1, deadline - performance.now())))
    }
  }
  try {
    report(phase, {
      mode,
      shell,
      argv: ['-c', 'exec "$BASH" --noprofile --norc -i'],
      markerDeadlineMs: 15_000,
      prompt: mode === 'original' ? undefined : prompt
    })
    proc = spawn(shell, ['-c', 'exec "$BASH" --noprofile --norc -i'], {
      cwd: tmpdir(),
      cols: 120,
      rows: 30,
      useConptyDll: true,
      env
    })
    proc.onExit((event) => {
      exit = event
      report('shell-exit', { mode, shellPid: proc?.pid, exit })
      resolveExit()
    })
    proc.onData((chunk) => {
      outputBytes += Buffer.byteLength(chunk)
      outputCodeUnits += chunk.length
      output = (output + chunk).slice(-32_768)
      const match = /MSYS_OWNED_CHILD=(\d+)/.exec(output)
      if (match) {
        childPid = Number(match[1])
      }
      if (streamedCodeUnits < 32_768) {
        const retained = chunk.slice(0, 32_768 - streamedCodeUnits)
        streamedCodeUnits += retained.length
        report('data', { mode, chunk: retained, outputBytes })
      }
    })
    if (mode === 'ready') {
      await observe('replacement-prompt', () => output.includes(prompt), markerDeadline)
      report('replacement-prompt', evidence())
    }
    phase = 'write-child-command'
    const commandWrittenAtMs = Math.round(performance.now() - spawnStarted)
    proc.write(
      `${quotePosixShell(process.execPath.replace(/\\/g, '/'))} ${quotePosixShell(script.replace(/\\/g, '/'))}\r`
    )
    report('write-child-command', { mode, shellPid: proc.pid, commandWrittenAtMs })
    await observe('child-marker', () => childPid !== undefined, markerDeadline)
    assert.ok(childPid, 'Missing child PID')
    report('child-marker', evidence())
    phase = 'membership'
    assert.equal(isAlive(childPid), true, 'Reported child must be live')
    assert.ok(
      listPtyJobProcessIds(proc)?.includes(childPid),
      'The child must belong to its PTY job'
    )
    report('membership', evidence())
    phase = 'terminate-job'
    assert.equal(terminatePtyJob(proc), 'terminated', 'The owning job must acknowledge termination')
    const terminationDeadline = performance.now() + 5_000
    while (isAlive(childPid) && performance.now() < terminationDeadline) {
      await delay(25)
    }
    assert.equal(isAlive(childPid), false, 'The owned child must exit within five seconds')
    report('passed', evidence())
  } catch (error) {
    report('failure', {
      ...evidence(),
      message: error instanceof Error ? error.stack : String(error)
    })
    failures.push(error)
  } finally {
    phase = 'cleanup'
    const noteCleanupFailure = (error: unknown) => {
      failures.push(error)
      report('cleanup-failure', {
        ...evidence(),
        message: error instanceof Error ? error.stack : String(error)
      })
    }
    try {
      if (childPid && isAlive(childPid)) {
        process.kill(childPid)
      }
    } catch (error) {
      noteCleanupFailure(error)
    }
    try {
      proc?.kill()
    } catch (error) {
      noteCleanupFailure(error)
    }
    if (proc) {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          exited,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Shell exit callback did not drain')), 5_000)
          })
        ])
      } catch (error) {
        noteCleanupFailure(error)
      } finally {
        clearTimeout(timer)
      }
    }
    try {
      removeTreeSync(directory)
    } catch (error) {
      noteCleanupFailure(error)
    }
    report('cleanup', { mode, shellPid: proc?.pid, childPid, exit, failures: failures.length })
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'MSYS sample or cleanup failed')
  }
}
