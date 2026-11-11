import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { classifyPrJobs } from './pr-code-change-scope.mjs'

const projectDir = resolve(import.meta.dirname, '../../../..')

/** The test files pr.yml's shell contracts job runs, read from the step itself so the two lists cannot drift apart silently. */
function shellContractsJobTests() {
  const workflow = readFileSync(resolve(projectDir, '.github/workflows/pr.yml'), 'utf8')
  const step = workflow.split('- name: Test real shell contracts')[1]?.split('\n\n')[0]
  expect(step, 'pr.yml must keep the "Test real shell contracts" step').toBeDefined()
  const tests = [...step.matchAll(/^\s+(\S+\.test\.ts)\s*\\?$/gm)].map((match) => match[1])
  expect(tests.length).toBeGreaterThan(10)
  return tests
}

describe('per-job path classification', () => {
  // Mobile-only edits must run audits that lint mobile; skipped audits let #20702 duplicate imports break later merge refs.

  // The ratchet: adding a tree to an audit command has to widen this trigger on its own.

  // Stale-base diffs exceed pipe buffer; one fd-0 read can exit 0 with no pairs, silently skipping every lane.
  it('classifies a path that arrives after the first pipe buffer', async () => {
    const filler = Array.from(
      { length: 12_000 },
      (_, index) => `docs/reference/generated-placeholder-${index}.md`
    )
    const input = `${[...filler, 'config/patches/xterm-upstream.json'].join('\n')}\n`
    expect(input.length).toBeGreaterThan(64 * 1024)

    const child = spawn(
      process.execPath,
      ['config/scripts/workflow/source-routing/pr-code-change-scope.mjs'],
      {
        cwd: projectDir,
        stdio: ['pipe', 'pipe', 'pipe']
      }
    )
    let stdout = ''
    let stderr = ''
    let brokePipe = false
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.stdin.on('error', (error) => {
      brokePipe ||= error.code === 'EPIPE'
    })

    const exitCode = await new Promise((resolvePromise) => {
      child.on('close', resolvePromise)
      let offset = 0
      const step = () => {
        if (offset >= input.length) {
          child.stdin.end()
          return
        }
        child.stdin.write(input.slice(offset, offset + 64 * 1024))
        offset += 64 * 1024
        setTimeout(step, 20)
      }
      step()
    })

    expect(stderr).not.toContain('EAGAIN')
    expect(brokePipe).toBe(false)
    expect(exitCode, stderr).toBe(0)
    expect(stdout).toContain('should_run=true\n')
    expect(stdout).toContain('xterm_patch_sync=true\n')
  })

  // Unit shards exclude live-shell tests, so a test the shell contracts job runs must also route a focused
  // edit to that job; otherwise a change to it, or to what it guards, runs no real shell at all (STA-2380 C2 F1).
  it('routes every test the shell contracts job runs to shell_contracts', () => {
    const unrouted = shellContractsJobTests().filter(
      (file) => classifyPrJobs([file]).shell_contracts !== true
    )
    expect(unrouted).toEqual([])
  })

  it('routes the command-paint attribution sources to shell_contracts, and only those', () => {
    const guarded = [
      'src/main/runtime/terminal/input/terminal-command-paint.ts',
      'src/main/runtime/terminal/wait/tui-idle-evidence-source.ts',
      'src/shared/draft-paste-ready-scanner.ts',
      'src/main/runtime/terminal/wait/tui-idle-zsh-preexec-hook-order.live-shell.test.ts'
    ]
    for (const file of guarded) {
      expect(classifyPrJobs([file]).shell_contracts, file).toBe(true)
    }
    // Neighbours the live-shell test does not guard stay on the ordinary unit shards.
    for (const file of [
      'src/main/runtime/terminal/wait/tui-idle-hook-lane.ts',
      'src/main/runtime/terminal/input/terminal-command-paint.test.ts',
      'src/shared/draft-paste-ready-scanner.test.ts'
    ]) {
      expect(classifyPrJobs([file]).shell_contracts, file).toBe(false)
    }
  })
})
