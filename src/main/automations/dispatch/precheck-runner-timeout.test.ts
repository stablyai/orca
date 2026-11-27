import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { runAutomationPrecheck } from './precheck-runner'

const directories: string[] = []
const strays: number[] = []

afterEach(() => {
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid)
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
