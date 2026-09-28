import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { spawnProcess, runProcess } from '../../src/shared/child-process/run-process'

const oracle = readFileSync(
  'config/docker/headless-serve-shutdown/run-appimage-desktop-startup-case.sh',
  'utf8'
)
const functions = oracle.slice(oracle.indexOf('read_start_ticks()'), oracle.indexOf('dump_logs()'))

function isRunning(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(') ') + 2)[0] !== 'Z'
  } catch {
    return false
  }
}

async function waitFor(predicate) {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Fixture readiness timed out')
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe.skipIf(process.platform !== 'linux')('AppImage startup process cleanup', () => {
  it('drains detached profile writers born during shutdown without touching a neighboring HOME', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-startup-cleanup-test-'))
    const profileHome = join(directory, 'home')
    mkdirSync(profileHome)
    const successorPidFile = join(directory, 'successor.pid')
    const readyFile = join(directory, 'ready')
    const writerCode = `
      const fs = require('node:fs');
      process.title = 'orca writer (x)';
      setInterval(() => fs.writeFileSync(process.env.HOME + '/state', 'alive'), 5);
      process.on('SIGTERM', () => {
        const child = require('node:child_process').spawn(process.execPath, ['-e',
          "setInterval(() => require('node:fs').writeFileSync(process.env.HOME + '/late-state', 'alive'), 5)"
        ], { detached: true, stdio: 'ignore', env: process.env });
        fs.writeFileSync(${JSON.stringify(successorPidFile)}, String(child.pid));
        child.unref();
        process.exit(0);
      });
      fs.writeFileSync(${JSON.stringify(readyFile)}, 'ready');
    `
    const writer = spawnProcess({
      program: process.execPath,
      args: ['-e', writerCode],
      detached: true,
      env: { ...process.env, HOME: profileHome },
      stdio: 'ignore'
    })
    const canary = spawnProcess({
      program: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      detached: true,
      env: { ...process.env, HOME: `${profileHome}-unrelated` },
      stdio: 'ignore'
    })
    try {
      await waitFor(() => {
        try {
          return readFileSync(readyFile, 'utf8') === 'ready'
        } catch {
          return false
        }
      })
      const result = await runProcess({
        program: 'bash',
        args: [
          '-c',
          `
          set -euo pipefail
          state_dir=$1
          tree_pids=()
          declare -A tree_start_ticks=()
          ${functions}
          collect_state_processes TERM
          wait_for_owned_exit 5 TERM
        `,
          'cleanup-fixture',
          directory
        ],
        timeoutMs: 10_000
      })
      expect(result.code, result.stderr).toBe(0)
      expect(result.timedOut).toBe(false)
      expect(isRunning(writer.pid)).toBe(false)
      expect(isRunning(Number(readFileSync(successorPidFile, 'utf8')))).toBe(false)
      expect(isRunning(canary.pid)).toBe(true)
    } finally {
      writer.kill('SIGKILL')
      canary.kill('SIGKILL')
      try {
        process.kill(Number(readFileSync(successorPidFile, 'utf8')), 'SIGKILL')
      } catch {}
      await waitFor(() => !isRunning(writer.pid) && !isRunning(canary.pid))
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
