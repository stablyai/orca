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

/** A pr.yml shaped like the real one around the shell contracts step, with `run` as the block scalar body. */
function workflowWithShellContractsRun(run) {
  const body = run
    .split('\n')
    .map((line) => (line === '' ? '' : `          ${line}`))
    .join('\n')
  return `jobs:
  shell_contracts:
    steps:
      - name: Install fish
        run: echo fish
      - name: ${SHELL_CONTRACTS_STEP}
        run: |
${body}
      - name: Later step
        run: pnpm exec vitest run src/later.test.ts
`
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

  describe('shell contracts step parsing', () => {
    it('reads every command of the step, past a blank line, and no other step', () => {
      const run = [
        'pnpm exec vitest run --maxWorkers=1 \\',
        '  src/first.live-shell.test.ts \\',
        '  src/second.node-pty.test.ts',
        '',
        '# A second command after a blank line is still part of the step.',
        'pnpm exec vitest run src/third.test.ts'
      ].join('\n')
      expect(shellContractsStepTests(workflowWithShellContractsRun(run))).toEqual([
        'src/first.live-shell.test.ts',
        'src/second.node-pty.test.ts',
        'src/third.test.ts'
      ])
    })

    it('returns the exact list, so a dropped entry is a failure rather than a smaller count', () => {
      const files = Array.from(
        { length: 12 },
        (_, index) => `src/shell-${index}.live-shell.test.ts`
      )
      const run = `pnpm exec vitest run --reporter=dot \\\n${files.map((file) => `  ${file} \\`).join('\n')}\n  --bail=1`
      expect(shellContractsStepTests(workflowWithShellContractsRun(run))).toEqual(files)
    })

    it('reports a missing step instead of an empty list', () => {
      expect(shellContractsStepTests('jobs:\n  shell_contracts:\n    steps: []\n')).toBeNull()
    })
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

  it('routes the command-paint attribution sources to shell_contracts, and only those', () => {
    const guarded = [
      'src/main/runtime/terminal/input/terminal-command-paint.ts',
      'src/main/runtime/terminal/wait/tui-idle-evidence-source.ts',
      'src/main/runtime/terminal/wait/tui-idle-evidence.ts',
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
