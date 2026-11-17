import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { UNIT_EXCLUDE } from '../../ci/unit-selection/dependency-graph/ci-unit-files.mjs'
import { classifyPrJobs } from './pr-code-change-scope.mjs'

const projectDir = resolve(import.meta.dirname, '../../../..')

const SHELL_CONTRACTS_STEP = 'Test real shell contracts'

/** Every test file the shell contracts step's whole `run` script names, across all of its commands.
 *  The YAML parser owns the block's extent, so a blank line or a later command cannot truncate the
 *  list (C3-3). Null when the step is gone. */
function shellContractsStepTests(workflowYaml) {
  const steps = parse(workflowYaml)?.jobs?.shell_contracts?.steps ?? []
  const step = steps.find((candidate) => candidate?.name === SHELL_CONTRACTS_STEP)
  if (typeof step?.run !== 'string') {
    return null
  }
  return step.run.split(/\s+/).filter((token) => token.endsWith('.test.ts'))
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
    const tests = shellContractsStepTests(
      readFileSync(resolve(projectDir, '.github/workflows/pr.yml'), 'utf8')
    )
    expect(tests, `pr.yml must keep the "${SHELL_CONTRACTS_STEP}" step`).not.toBeNull()
    // Partial-omission guard with an independent source: every real-shell test the unit shards exclude
    // is run by this job or by nothing, so each must appear in the parsed step.
    const realShellTests = UNIT_EXCLUDE.filter((file) =>
      /\.(?:live-shell|node-pty)\.test\.ts$/.test(file)
    )
    expect(realShellTests.length).toBeGreaterThan(0)
    expect(tests).toEqual(expect.arrayContaining(realShellTests))
    const unrouted = tests.filter((file) => classifyPrJobs([file]).shell_contracts !== true)
    expect(unrouted).toEqual([])
  })
})
