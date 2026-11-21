import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const projectDir = resolve(import.meta.dirname, '../../../..')

describe('per-job path classification', () => {
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
})
