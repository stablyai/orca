import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  _resetZCodeInteractiveCapabilityForTests,
  readZCodeInteractiveCapability
} from './interactive-capability'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-zcode-capability-'))
  _resetZCodeInteractiveCapabilityForTests()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function writeZCode(dir: string, stderr: string): string {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'zcode')
  const log = join(root, 'runs.log')
  writeFileSync(file, `#!/bin/sh\necho "$0[$*]" >> "${log}"\necho "${stderr}" 1>&2\nexit 1\n`)
  chmodSync(file, 0o755)
  return file
}

function runs(): string[] {
  try {
    return readFileSync(join(root, 'runs.log'), 'utf8').trim().split('\n')
  } catch {
    return []
  }
}

const MISSING_TUI = "Cannot find package '@zcode/tui'"

describe.skipIf(process.platform === 'win32')('readZCodeInteractiveCapability', () => {
  it('finds zcode outside the GUI PATH and runs it with its sibling node', async () => {
    const bin = join(root, 'home', '.volta', 'bin')
    mkdirSync(bin, { recursive: true })
    // Any other node would run this script cleanly; only the sibling reports the missing TUI.
    writeFileSync(join(bin, 'zcode'), '#!/usr/bin/env node\nprocess.exit(0)\n')
    writeFileSync(join(bin, 'node'), `#!/bin/sh\necho "${MISSING_TUI}" 1>&2\nexit 1\n`)
    chmodSync(join(bin, 'zcode'), 0o755)
    chmodSync(join(bin, 'node'), 0o755)

    await expect(
      readZCodeInteractiveCapability(undefined, {
        pathEnv: join(root, 'empty'),
        homePath: join(root, 'home')
      })
    ).resolves.toBe('missing-tui')
  })

  it('probes the zcode Command setting with its arguments, with a verdict per command', async () => {
    const options = { pathEnv: join(root, 'empty'), homePath: join(root, 'home') }
    const broken = writeZCode(join(root, 'broken'), MISSING_TUI)
    const healthy = writeZCode(join(root, 'healthy'), 'Raw mode is not supported')
    const settings = (zcode: string) => ({ agentCmdOverrides: { zcode } })

    await expect(
      readZCodeInteractiveCapability(settings(`${broken} --mode yolo`), options)
    ).resolves.toBe('missing-tui')
    await expect(readZCodeInteractiveCapability(settings(healthy), options)).resolves.toBe(
      'interactive'
    )
    expect(runs()).toEqual([`${broken}[--mode yolo]`, `${healthy}[]`])
  })
})
