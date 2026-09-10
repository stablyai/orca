import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('maestro CLI subprocess check', () => {
  it('fails before building when Python is unavailable', () => {
    const result = spawnSync(
      process.execPath,
      [resolve(process.cwd(), 'config/scripts/run-maestro-cli-subprocess-check.mjs')],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, PATH: '', Path: '' }
      }
    )

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Python 3 is required for the Maestro CLI subprocess check.')
  })

  it('includes the required permission policy coverage in the focused phase', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'config/scripts/run-maestro-cli-subprocess-check.mjs'),
      'utf8'
    )
    expect(source).toContain("'src/shared/tui-agent-permissions.test.ts'")
  })

  it('proves the real spawn boundary with a bounded pattern instead of the whole 43k-line suite', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'config/scripts/run-maestro-cli-subprocess-check.mjs'),
      'utf8'
    )
    expect(source).toContain("'src/main/runtime/orca-runtime.test.ts'")
    expect(source).toContain(
      'injects the exact bounded ManagedCliContext into the spawned env for an orchestration-managed launch'
    )
    expect(source).toContain(
      'never injects a ManagedCliContext into the spawned env for an ordinary manual terminal'
    )
    expect(source).toContain('overwrites a caller-forged ORCA_MANAGED_CLI_')
    expect(source).toContain('strips a caller-forged ORCA_MANAGED_CLI_')
  })
})
