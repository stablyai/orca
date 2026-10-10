import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runProcess } from './run-process'
import { RELAY_LSOF_PROBE_JS } from './posix-lsof-probe'

// Keep group evidence deterministic when the host immediately reaps orphaned helpers.
const PRELOAD = String.raw`
var cp = require('child_process');
var fs = require('fs');
var spawn = cp.spawn;
var kill = process.kill.bind(process);
var lsofPid;
var censusPid;
cp.spawn = function(program, args, options) {
  var child = spawn(program, args, options);
  if (program === 'lsof') {
    lsofPid = child.pid;
    fs.writeFileSync(process.env.PROBE_PID, String(child.pid));
    if (process.env.STARTUP_SIGNAL) {
      kill(process.pid, process.env.STARTUP_SIGNAL);
      var end = Date.now() + 100;
      while (Date.now() < end) {}
    }
  }
  if (program === 'ps') {
    censusPid = child.pid;
    fs.writeFileSync(process.env.PS_PID, String(child.pid));
  }
  return child;
};
process.kill = function(pid, signal) {
  if (process.env.CENSUS_KILL_DENIED && pid === -censusPid && signal === 'SIGKILL') {
    var error = new Error('fixture census kill denied');
    error.code = 'EPERM';
    throw error;
  }
  if (process.env.GROUP_STILL_EXISTS && pid === -lsofPid && signal === 0) {
    if (process.env.CENSUS_KILL_DENIED && censusPid) return kill(pid, signal);
    return true;
  }
  return kill(pid, signal);
};
`

async function runProbe(options: {
  signal?: string
  census?: string
  censusKillDenied?: boolean
  /** Replaces the whole stub `lsof` body, for cases about what lsof answered. */
  lsof?: string
  sockPath?: string
}) {
  const dir = mkdtempSync(join(tmpdir(), 'orca-lsof-lifecycle-'))
  const pidFile = join(dir, 'lsof.pid')
  const psPidFile = join(dir, 'ps.pid')
  try {
    writeFileSync(join(dir, 'preload.cjs'), PRELOAD)
    writeFileSync(
      join(dir, 'lsof'),
      options.lsof ?? `#!/bin/sh\necho 123\n${options.signal ? 'exec sleep 60\n' : 'exit 2\n'}`,
      { mode: 0o755 }
    )
    if (options.census !== undefined) {
      writeFileSync(join(dir, 'ps'), `#!/bin/sh\n${options.census}`, { mode: 0o755 })
    }
    const started = performance.now()
    const result = await runProcess({
      program: process.execPath,
      args: [
        '--require',
        join(dir, 'preload.cjs'),
        '-e',
        RELAY_LSOF_PROBE_JS,
        options.sockPath ?? '/unused.sock'
      ],
      env: {
        ...process.env,
        ORCA_BACKGROUND_LAUNCH: '1',
        PATH: `${dir}:${process.env.PATH}`,
        PROBE_PID: pidFile,
        PS_PID: psPidFile,
        STARTUP_SIGNAL: options.signal ?? '',
        GROUP_STILL_EXISTS: options.census === undefined ? '' : '1',
        CENSUS_KILL_DENIED: options.censusKillDenied ? '1' : ''
      },
      timeoutMs: 10000,
      detached: true,
      terminationBarrier: true
    })
    for (const file of [pidFile, psPidFile]) {
      let pid: string
      try {
        pid = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      const state = await runProcess({
        program: 'ps',
        args: ['-o', 'state=', '-p', pid],
        timeoutMs: 2000
      })
      expect(
        (state.code === 1 && !state.stdout.trim()) ||
          (state.code === 0 && state.stdout.trim().startsWith('Z'))
      ).toBe(true)
    }
    if (options.censusKillDenied) {
      expect(process.kill(-Number(readFileSync(psPidFile, 'utf8')), 0)).toBe(true)
    }
    return { ...result, elapsedMs: performance.now() - started }
  } finally {
    for (const file of [pidFile, psPidFile]) {
      try {
        const pid = Number(readFileSync(file, 'utf8'))
        if (Number.isSafeInteger(pid) && pid > 0) {
          process.kill(-pid, 'SIGKILL')
        }
      } catch {}
    }
    rmSync(dir, { recursive: true, force: true })
  }
}

describe.skipIf(process.platform === 'win32')('lsof supervisor lifecycle', () => {
  it.each(['SIGTERM', 'SIGHUP', 'SIGINT'])(
    'owns lsof when %s arrives inside spawn',
    async (signal) => {
      const result = await runProbe({ signal })
      expect(result).toMatchObject({ code: 0, signal: null, timedOut: false })
      expect(result.stdout.split('\n')[0]).toBe('unavailable')
    }
  )

  it('accepts zombie-only group evidence after the direct child closes', async () => {
    const result = await runProbe({ census: 'printf "%s Z\\n" "$(cat "$PROBE_PID")"\n' })
    expect(result.stdout).toBe('unavailable\n123\n')
    expect(result.timedOut).toBe(false)
  })

  it('requires census cleanup even when the lsof group disappears', async () => {
    const result = await runProbe({
      census: 'sleep 60 </dev/null >/dev/null 2>&1 &\nexit 0\n',
      censusKillDenied: true
    })
    expect(result.stdout).toBe('cleanup-unconfirmed\n123\n')
    expect(result).toMatchObject({ code: 0, signal: null, timedOut: false })
  })

  it.each([
    ['live member', 'printf "%s S\\n" "$(cat "$PROBE_PID")"\n'],
    ['failed census', 'exit 1\n'],
    ['missing group', 'printf "1 Z\\n"\n'],
    ['empty census', 'exit 0\n'],
    ['malformed census', 'echo malformed\n'],
    ['incomplete record', 'printf "%s Z" "$(cat "$PROBE_PID")"\n'],
    ['hung census', 'echo $$ > "$PS_PID"\nexec sleep 60\n'],
    ['oversized census', 'head -c 9000000 /dev/zero\n']
  ])('keeps cleanup unconfirmed for %s', async (_name, census) => {
    const result = await runProbe({ census })
    expect(result.stdout).toBe('cleanup-unconfirmed\n123\n')
    expect(result).toMatchObject({ code: 0, signal: null, timedOut: false })
    expect(result.elapsedMs).toBeLessThan(4000)
  })
})

/**
 * When the probe runs as a uid that does not own the socket's holder, `lsof -t -a -U <path>`
 * exits 1 with no stdout and no stderr. Measured on Debian 12: a live relay owned by root,
 * probed as `nobody`, produced `exit=1 stdout=[] stderr=[]` — byte-identical to a genuinely
 * stale socket, so no amount of inspecting lsof's answer can separate the two. That answer
 * reaches `verdict: exited / evidence: no-holder`, which `classifySupersededRelay` turns into
 * `rm -f` on an inode a live relay still holds.
 *
 * The stub reproduces that exact shape rather than switching uid, which needs root and two
 * accounts. What separates the cases is /proc/net/unix, which is world-readable.
 */
const linuxOnly = describe.skipIf(process.platform !== 'linux')

linuxOnly('lsof blindness to another uid', () => {
  const BLIND_LSOF = '#!/bin/sh\nexit 1\n'

  it('has the evidence these assertions depend on', () => {
    // Why asserted rather than assumed: without /proc/net/unix every case below passes
    // vacuously, and a silently degraded suite would stop covering the only thing that
    // separates "lsof could not see" from "nothing holds it".
    expect(existsSync('/proc/net/unix')).toBe(true)
  })

  async function withBoundSocket<T>(run: (sockPath: string) => Promise<T>): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), 'orca-lsof-bound-'))
    const sockPath = join(dir, 'held.sock')
    const server = createServer(() => {})
    await new Promise<void>((resolve) => {
      server.listen(sockPath, () => resolve())
    })
    try {
      return await run(sockPath)
    } finally {
      server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('reports unavailable when nothing was reported for a socket that is still bound', async () => {
    const result = await withBoundSocket((sockPath) => runProbe({ lsof: BLIND_LSOF, sockPath }))
    expect(result.stdout).toBe('unavailable\n\n')
  })

  it('still reports lsof for an empty answer about a path nothing has bound', async () => {
    // The control that keeps this from becoming a universal accumulation bug: on a healthy
    // host a genuinely stale socket has no /proc/net/unix entry and must stay reapable.
    const dir = mkdtempSync(join(tmpdir(), 'orca-lsof-stale-'))
    try {
      const result = await runProbe({ lsof: BLIND_LSOF, sockPath: join(dir, 'never-bound.sock') })
      expect(result.stdout).toBe('lsof\n\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps a reported pid even while the path is still bound', async () => {
    const result = await withBoundSocket((sockPath) =>
      runProbe({ lsof: '#!/bin/sh\necho 123\nexit 0\n', sockPath })
    )
    expect(result.stdout).toBe('lsof\n123\n')
  })

  // Both neighbours of the bound path, because a substring test would pass one and fail the
  // other: `<sock>` is a prefix of the bound path, and the bound path is a prefix of
  // `<sock>.other`. Only exact equality answers correctly for both.
  it.each([
    ['a prefix of the bound path', (sockPath: string) => sockPath.slice(0, -1)],
    ['a path the bound one prefixes', (sockPath: string) => `${sockPath}.other`]
  ])('does not treat %s as bound', async (_name, derive) => {
    const result = await withBoundSocket((sockPath) =>
      runProbe({ lsof: BLIND_LSOF, sockPath: derive(sockPath) })
    )
    expect(result.stdout).toBe('lsof\n\n')
  })
})
