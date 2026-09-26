import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveCommandPathsForRelay } from './relay-command-path-lookup'

// Why: the sibling test mocks child_process, so only this file proves the generated
// batch script actually runs in a real POSIX shell.
describe.skipIf(process.platform === 'win32')('resolveCommandPathsForRelay (real /bin/sh)', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'orca-batch-lookup-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function makeExecutable(dir: string, name: string): string {
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, name)
    writeFileSync(file, '#!/bin/sh\nexit 0\n')
    chmodSync(file, 0o755)
    return file
  }

  it('resolves many commands in one real shell, first PATH hit wins', async () => {
    const first = path.join(root, 'first')
    const second = path.join(root, 'second')
    const claude = makeExecutable(first, 'claude')
    makeExecutable(second, 'claude')
    const codex = makeExecutable(second, 'codex')
    const quoted = makeExecutable(second, "agent'cli")
    // A directory and a non-executable file named like CLIs must not count as installs.
    mkdirSync(path.join(first, 'orca-test-dir-cli'))
    writeFileSync(path.join(first, 'orca-test-plain-file'), 'not executable')

    const resolved = await resolveCommandPathsForRelay(
      [
        'claude',
        'codex',
        "agent'cli",
        'orca-test-dir-cli',
        'orca-test-plain-file',
        'orca-test-missing'
      ],
      {
        platform: process.platform,
        env: { PATH: `${first}:${second}`, HOME: root },
        accountLoginShell: null
      }
    )

    expect(Object.fromEntries(resolved)).toEqual({
      claude,
      codex,
      "agent'cli": quoted,
      'orca-test-dir-cli': null,
      'orca-test-plain-file': null,
      'orca-test-missing': null
    })
  })
})
