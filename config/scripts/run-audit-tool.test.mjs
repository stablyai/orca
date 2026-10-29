import { join, resolve } from 'node:path'
import { runProcessSync } from '@orca/process-host'
import { DEFAULT_MAX_OUTPUT_BYTES } from '@orca/process-host/process-spec'
import { describe, expect, it, vi } from 'vitest'

import { auditToolEntry, runAuditTool } from './run-audit-tool.mjs'

const root = resolve(import.meta.dirname, '../..')
const success = { code: 0, signal: null, timedOut: false }

describe('locked audit tool execution', () => {
  it('installs frozen without scripts before forwarding tool arguments directly to Node', () => {
    const calls = []
    const args = ['.', '--scope', 'lines', '--base', 'branch with & shell $characters']
    const failed = { code: 7, signal: null, timedOut: false }
    const result = runAuditTool('react-doctor', args, {
      root,
      run: (spec) => {
        calls.push(spec)
        return calls.length === 1 ? success : failed
      }
    })
    expect(calls).toHaveLength(2)
    expect(calls[0].args.slice(-5)).toEqual([
      '--dir',
      join(root, 'config', 'audit-tools'),
      'install',
      '--frozen-lockfile',
      '--ignore-scripts'
    ])
    expect(calls[1]).toEqual({
      program: process.execPath,
      args: [auditToolEntry('react-doctor', root), ...args],
      cwd: root,
      stdio: 'inherit',
      maxOutputBytes: 64 * 1024 * 1024,
      timeoutMs: null
    })
    expect(result).toBe(failed)
  })

  it('captures structured tool output without hiding the installation log', () => {
    const calls = []
    const output = { ...success, stdout: '{"ok":true}' }
    expect(
      runAuditTool('react-doctor', ['.', '--json'], {
        stdio: 'pipe',
        run: (spec) => {
          calls.push(spec)
          return calls.length === 1 ? success : output
        }
      })
    ).toBe(output)
    expect(calls[0].stdio).toBe('inherit')
    expect(calls[1].stdio).toBe('pipe')
  })

  it('captures reports larger than the default subprocess output limit', () => {
    const reportSize = DEFAULT_MAX_OUTPUT_BYTES + 1024
    const result = runAuditTool('react-doctor', ['.', '--json'], {
      stdio: 'pipe',
      run: (spec) =>
        spec.stdio === 'inherit'
          ? success
          : runProcessSync({
              ...spec,
              args: ['-e', `process.stdout.write('x'.repeat(${reportSize}))`]
            })
    })

    expect(result.code).toBe(0)
    expect(result.outputTruncated).toBe(false)
    expect(result.stdout).toHaveLength(reportSize)
  })

  it.each([
    { code: 1, signal: null, timedOut: false },
    { code: null, signal: 'SIGTERM', timedOut: false },
    { code: null, signal: null, timedOut: true }
  ])('does not execute a tool after install failure: %j', (failure) => {
    let count = 0
    expect(
      runAuditTool('knip', [], {
        run: () => {
          count += 1
          return failure
        }
      })
    ).toBe(failure)
    expect(count).toBe(1)
  })

  it('rejects an unknown executable before installing anything', () => {
    const run = vi.fn()
    expect(() => runAuditTool('../arbitrary-package', [], { run })).toThrow('Unknown audit tool')
    expect(run).not.toHaveBeenCalled()
  })
})
