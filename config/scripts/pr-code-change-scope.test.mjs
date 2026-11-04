import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  classifyPrJobs,
  PR_CHECK_JOBS,
  STATIC_ANALYSIS_SCAN_ROOTS
} from './pr-code-change-scope.mjs'

const projectDir = resolve(import.meta.dirname, '../..')

describe('per-job path classification', () => {
  it('runs every expensive job on an empty diff rather than skipping by accident', () => {
    const result = classifyPrJobs([])
    expect(result.should_run).toBe(true)
    for (const job of PR_CHECK_JOBS) {
      expect(result[job], job).toBe(true)
    }
  })

  it('runs it on a mobile-only diff, which should_run alone would skip', () => {
    const classified = classifyPrJobs(['mobile/app/h/[hostId]/tasks.tsx'])
    expect([classified.should_run, classified.mobile_web_app]).toEqual([false, true])
  })

  it('runs workflow-self-change and lockfile diffs as force-all', () => {
    const result = classifyPrJobs(['.github/workflows/pr.yml'])
    expect(result.should_run).toBe(true)
    for (const job of PR_CHECK_JOBS) {
      expect(result[job], job).toBe(true)
    }
    expect(classifyPrJobs(['pnpm-lock.yaml']).git_compatibility).toBe(true)
  })

  // Mobile-only edits must run audits that lint mobile; skipped audits let #20702 duplicate imports break later merge refs.
  it('runs static analysis for a mobile-only diff without dragging in the desktop suite', () => {
    const result = classifyPrJobs([
      'mobile/src/test-support/rpc-recording/adapters/push-registration-mount-adapters.ts'
    ])
    expect(result.static_analysis).toBe(true)
    expect(result.mobile_dependencies).toBe(true)
    expect(result.should_run).toBe(false)
    for (const job of ['typecheck', 'test', 'package', 'package_windows', 'git_compatibility']) {
      expect(result[job], job).toBe(false)
    }
  })

  // The ratchet: adding a tree to an audit command has to widen this trigger on its own.
  it('runs static analysis for every tree the audit commands scan', () => {
    expect(STATIC_ANALYSIS_SCAN_ROOTS).toEqual(
      expect.arrayContaining(['src', 'config', 'tests', 'mobile'])
    )
    for (const root of STATIC_ANALYSIS_SCAN_ROOTS) {
      expect(classifyPrJobs([`${root}/changed-file.ts`]).static_analysis, root).toBe(true)
    }
  })

  // Stale-base diffs exceed pipe buffer; one fd-0 read can exit 0 with no pairs, silently skipping every lane.
  it('classifies a path that arrives after the first pipe buffer', async () => {
    const filler = Array.from(
      { length: 12_000 },
      (_, index) => `docs/reference/generated-placeholder-${index}.md`
    )
    const input = `${[...filler, 'config/patches/xterm-upstream.json'].join('\n')}\n`
    expect(input.length).toBeGreaterThan(64 * 1024)

    const child = spawn(process.execPath, ['config/scripts/pr-code-change-scope.mjs'], {
      cwd: projectDir,
      stdio: ['pipe', 'pipe', 'pipe']
    })
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
})
