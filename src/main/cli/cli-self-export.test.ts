import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ORCA_CLI_SELF_EXPORT } from './cli-self-export'

const ORCA_CLI_SELF_ENV = 'ORCA_CLI_SELF'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-cli-self-export-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeScript(name: string, body: string): string {
  const path = join(dir, name)
  writeFileSync(path, `#!/usr/bin/env bash\n${body}`)
  chmodSync(path, 0o755)
  return path
}

describe.skipIf(process.platform === 'win32')('the launcher self export', () => {
  it('names the outermost Orca script, so a shim that execs a launcher stays the entry', () => {
    const report = join(dir, 'report')
    const launcher = writeScript(
      'orca-ide',
      `${ORCA_CLI_SELF_EXPORT}printf '%s' "$ORCA_CLI_SELF" > '${report}'\n`
    )
    const shim = writeScript('orca', `${ORCA_CLI_SELF_EXPORT}exec '${launcher}' "$@"\n`)
    const env = { ...process.env }
    delete env[ORCA_CLI_SELF_ENV]

    expect(spawnSync(shim, [], { env }).status).toBe(0)
    expect(readFileSync(report, 'utf8')).toBe(shim)

    expect(spawnSync(launcher, [], { env }).status).toBe(0)
    expect(readFileSync(report, 'utf8')).toBe(launcher)
  })

  it.each(['resources/darwin/bin/orca', 'resources/linux/bin/orca-ide'])(
    'is the line the packaged %s launcher runs',
    (path) => {
      expect(readFileSync(join(process.cwd(), path), 'utf8')).toContain(ORCA_CLI_SELF_EXPORT)
    }
  )
})
