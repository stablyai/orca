import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ATTRIBUTION_BOUND_EXCEEDED_EXIT_CODE,
  ATTRIBUTION_COMMAND_OUTPUT_MAX_BYTES,
  ATTRIBUTION_COMMIT_MESSAGE_MAX_BYTES,
  applyTerminalAttributionEnv
} from './terminal-attribution'

const roots: string[] = []
const posixIt = process.platform === 'win32' ? it.skip : it

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-attribution-bounds-'))
  roots.push(root)
  return root
}

function attributionEnv(root: string, binDir: string): Record<string, string> {
  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` }
  applyTerminalAttributionEnv(env as Record<string, string>, {
    enabled: true,
    userDataPath: join(root, 'user-data')
  })
  return env as Record<string, string>
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('terminal attribution payload bounds', () => {
  posixIt('accepts a commit message file at the exact byte boundary', () => {
    const root = makeRoot()
    const binDir = join(root, 'bin')
    const messagePath = join(root, 'message.txt')
    const receivedPath = join(root, 'received-message.txt')
    mkdirSync(binDir)
    writeFileSync(messagePath, 'm'.repeat(ATTRIBUTION_COMMIT_MESSAGE_MAX_BYTES))
    writeFileSync(
      join(binDir, 'git'),
      `#!/usr/bin/env bash
set -euo pipefail
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-F" || "$1" == "--file" ]]; then
    cp "$2" "${receivedPath}"
    exit 0
  fi
  shift
done
exit 2
`
    )
    chmodSync(join(binDir, 'git'), 0o755)

    const result = spawnSync('git', ['commit', '-F', messagePath], {
      encoding: 'utf8',
      env: attributionEnv(root, binDir)
    })

    expect(result.status).toBe(0)
    expect(readFileSync(receivedPath, 'utf8')).toBe(
      `${'m'.repeat(ATTRIBUTION_COMMIT_MESSAGE_MAX_BYTES)}\n\nCo-authored-by: Orca <help@stably.ai>\n`
    )
  })

  posixIt('rejects a sparse commit message file one byte over the boundary', () => {
    const root = makeRoot()
    const binDir = join(root, 'bin')
    const messagePath = join(root, 'message.txt')
    const calledPath = join(root, 'git-called')
    mkdirSync(binDir)
    writeFileSync(messagePath, 'm')
    truncateSync(messagePath, ATTRIBUTION_COMMIT_MESSAGE_MAX_BYTES + 1)
    writeFileSync(
      join(binDir, 'git'),
      `#!/usr/bin/env bash
touch "${calledPath}"
exit 0
`
    )
    chmodSync(join(binDir, 'git'), 0o755)

    const result = spawnSync('git', ['commit', '-F', messagePath], {
      encoding: 'utf8',
      env: attributionEnv(root, binDir)
    })

    expect(result.status).toBe(ATTRIBUTION_BOUND_EXCEEDED_EXIT_CODE)
    expect(result.stderr).toContain(
      `${ATTRIBUTION_COMMIT_MESSAGE_MAX_BYTES + 1} bytes exceeds the ${ATTRIBUTION_COMMIT_MESSAGE_MAX_BYTES}-byte limit`
    )
    expect(existsSync(calledPath)).toBe(false)
  })

  posixIt('preserves gh output at the exact byte boundary', () => {
    const root = makeRoot()
    const binDir = join(root, 'bin')
    const payloadPath = join(root, 'gh-output.txt')
    mkdirSync(binDir)
    writeFileSync(payloadPath, 'o'.repeat(ATTRIBUTION_COMMAND_OUTPUT_MAX_BYTES))
    writeFileSync(
      join(binDir, 'gh'),
      `#!/usr/bin/env bash
cat "${payloadPath}"
`
    )
    chmodSync(join(binDir, 'gh'), 0o755)

    const result = spawnSync('gh', ['pr', 'create', '--fill'], {
      encoding: 'utf8',
      env: attributionEnv(root, binDir),
      maxBuffer: ATTRIBUTION_COMMAND_OUTPUT_MAX_BYTES + 64 * 1024
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toBe('o'.repeat(ATTRIBUTION_COMMAND_OUTPUT_MAX_BYTES))
    expect(result.stderr).toBe('')
  })

  posixIt('fails clearly when gh output is one byte over the boundary', () => {
    const root = makeRoot()
    const binDir = join(root, 'bin')
    const payloadPath = join(root, 'gh-output.txt')
    mkdirSync(binDir)
    writeFileSync(payloadPath, 'o'.repeat(ATTRIBUTION_COMMAND_OUTPUT_MAX_BYTES + 1))
    writeFileSync(
      join(binDir, 'gh'),
      `#!/usr/bin/env bash
cat "${payloadPath}"
`
    )
    chmodSync(join(binDir, 'gh'), 0o755)

    const result = spawnSync('gh', ['pr', 'create', '--fill'], {
      encoding: 'utf8',
      env: attributionEnv(root, binDir)
    })

    expect(result.status).toBe(ATTRIBUTION_BOUND_EXCEEDED_EXIT_CODE)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain(
      `${ATTRIBUTION_COMMAND_OUTPUT_MAX_BYTES + 1} bytes exceeds the ${ATTRIBUTION_COMMAND_OUTPUT_MAX_BYTES}-byte limit`
    )
  })

  it('emits inclusive PowerShell byte boundaries for commit files and gh captures', () => {
    const root = makeRoot()
    applyTerminalAttributionEnv(
      { PATH: process.env.PATH ?? '' },
      { enabled: true, userDataPath: join(root, 'user-data') }
    )
    const shimDir = join(root, 'user-data', 'orca-terminal-attribution', 'win32')
    const gitWrapper = readFileSync(join(shimDir, 'git-wrapper.ps1'), 'utf8')
    const ghWrapper = readFileSync(join(shimDir, 'gh-wrapper.ps1'), 'utf8')

    expect(gitWrapper).toContain('$guard.Length -gt $MaxBytes')
    expect(gitWrapper).toContain(`'commit message file' ${ATTRIBUTION_COMMIT_MESSAGE_MAX_BYTES}`)
    expect(gitWrapper).toContain(`exit ${ATTRIBUTION_BOUND_EXCEEDED_EXIT_CODE}`)
    expect(ghWrapper).toContain(`$stdoutBytes -gt ${ATTRIBUTION_COMMAND_OUTPUT_MAX_BYTES}`)
    expect(ghWrapper).toContain(`$stderrBytes -gt ${ATTRIBUTION_COMMAND_OUTPUT_MAX_BYTES}`)
    expect(ghWrapper).toContain(`exit ${ATTRIBUTION_BOUND_EXCEEDED_EXIT_CODE}`)
  })
})
