import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { runAutomationPrecheck } from './precheck-runner'

const directories: string[] = []
const strays: number[] = []

afterEach(() => {
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

// The root exits at once; a detached grandchild (outside its job or process group) keeps the
// inherited pipes open well past the timeout, as a descendant a tree kill missed would.
const ORPHAN_HOLDING_PIPES = `
const { spawn } = require('node:child_process')
const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
  stdio: 'inherit',
  detached: true
})
process.stdout.write('grandchild:' + grandchild.pid + '\\n')
grandchild.unref()
`

// Waits out the precheck's own 5 s timeout, after a real shell and node launch.
it('settles a timed-out precheck whose exited root left descendants holding its pipes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-precheck-'))
  directories.push(directory)
  const script = join(directory, 'orphan.cjs')
  writeFileSync(script, ORPHAN_HOLDING_PIPES)

  const result = await runAutomationPrecheck({
    precheck: { command: `"${process.execPath}" "${script}"`, timeoutSeconds: 5 },
    target: { type: 'local', cwd: tmpdir() }
  })
  const pid = /grandchild:(\d+)/.exec(JSON.stringify(result))?.[1]
  if (pid) {
    strays.push(Number(pid))
  }

  expect(pid).toBeDefined()
  expect(JSON.stringify(result)).toContain('Precheck timed out after 5s.')
}, 30_000)

// The root exits at once; a member of its process group ignores SIGTERM and holds the pipes, so only
// the SIGKILL escalation ends it.
const SIGTERM_IGNORING_GROUP_MEMBER = `
const { spawn } = require('node:child_process')
const member = spawn(
  process.execPath,
  ['-e', "process.on('SIGTERM', () => {}); setTimeout(() => {}, 60000)"],
  { stdio: 'inherit' }
)
process.stdout.write('member:' + member.pid + '\\n')
member.unref()
`

const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Waits out the precheck's 5 s timeout and its 2 s SIGKILL escalation, after real shell and node launches.
it.skipIf(process.platform === 'win32')(
  'still SIGKILLs a group member that ignored SIGTERM once the timed-out precheck settles',
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-precheck-'))
    directories.push(directory)
    const script = join(directory, 'group-member.cjs')
    writeFileSync(script, SIGTERM_IGNORING_GROUP_MEMBER)

    const result = await runAutomationPrecheck({
      precheck: { command: `"${process.execPath}" "${script}"`, timeoutSeconds: 5 },
      target: { type: 'local', cwd: tmpdir() }
    })
    const pid = Number(/member:(\d+)/.exec(JSON.stringify(result))?.[1])
    if (pid) {
      strays.push(pid)
    }

    expect(pid).toBeGreaterThan(0)
    expect(JSON.stringify(result)).toContain('Precheck timed out after 5s.')
    await vi.waitFor(() => expect(isRunning(pid)).toBe(false), { timeout: 10_000, interval: 100 })
  },
  30_000
)
