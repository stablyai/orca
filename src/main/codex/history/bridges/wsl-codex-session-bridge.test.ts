import { beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { runWslProcessMock } = vi.hoisted(() => ({
  runWslProcessMock: vi.fn()
}))

// The E9 running check has its own cases; these cover the chain once the distro runs.
vi.mock('../../../wsl/filesystem/wsl-unc-access-gate', () => ({
  assertWslUncPathRunning: async () => {}
}))
vi.mock('../../../wsl/execution/wsl-runner', () => ({
  runWslProcess: runWslProcessMock
}))
import { _internals } from './wsl-codex-session-bridge'
import { buildWslCodexSessionBridgeShellCommand } from './wsl-codex-session-bridge-script'

beforeEach(() => {
  runWslProcessMock.mockReset()
  _internals.reset()
})

describe('buildWslCodexSessionBridgeShellCommand', () => {
  it.skipIf(process.platform === 'win32')(
    'publishes a verified guest-side copy across filesystems',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'orca-wsl-session-bridge-cross-fs-'))
      const sourceSessionsRoot = join(root, 'legacy', 'sessions')
      const managedSessionsRoot = join(root, 'managed', 'sessions')
      const binDir = join(root, 'bin')
      const relativePath = join('2026', '08', '26', 'retired.jsonl')
      const sourcePath = join(sourceSessionsRoot, relativePath)
      const targetPath = join(managedSessionsRoot, relativePath)
      mkdirSync(join(sourcePath, '..'), { recursive: true })
      mkdirSync(binDir)
      writeFileSync(sourcePath, '{"session":"retired"}\n', 'utf-8')
      const lnShimPath = join(binDir, 'ln')
      writeFileSync(
        lnShimPath,
        `#!/bin/sh
if [ "$2" = "$BRIDGE_SOURCE" ] && [ "$3" = "$BRIDGE_TARGET" ]; then
  exit 1
fi
exec /bin/ln "$@"
`
      )
      chmodSync(lnShimPath, 0o755)
      const shellCommand = buildWslCodexSessionBridgeShellCommand({
        systemSessionsRoot: sourceSessionsRoot,
        managedSessionsRoot
      })

      try {
        execFileSync('/bin/bash', ['-c', shellCommand], {
          env: {
            ...process.env,
            BRIDGE_SOURCE: sourcePath,
            BRIDGE_TARGET: targetPath,
            PATH: `${binDir}:${process.env.PATH ?? ''}`
          }
        })
        expect(readFileSync(targetPath, 'utf-8')).toBe('{"session":"retired"}\n')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'leaves an existing copied session to its current writer',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'orca-wsl-session-bridge-existing-'))
      const sourceSessionsRoot = join(root, 'legacy', 'sessions')
      const managedSessionsRoot = join(root, 'managed', 'sessions')
      const relativePath = join('2026', '08', '26', 'retired.jsonl')
      const sourcePath = join(sourceSessionsRoot, relativePath)
      const targetPath = join(managedSessionsRoot, relativePath)
      mkdirSync(join(sourcePath, '..'), { recursive: true })
      mkdirSync(join(targetPath, '..'), { recursive: true })
      writeFileSync(sourcePath, '{"session":"retired"}\n{"event":"legacy"}\n', 'utf-8')
      writeFileSync(targetPath, '{"session":"retired"}\n', 'utf-8')
      const shellCommand = buildWslCodexSessionBridgeShellCommand({
        systemSessionsRoot: sourceSessionsRoot,
        managedSessionsRoot
      })

      try {
        execFileSync('/bin/bash', ['-c', shellCommand])
        expect(readFileSync(targetPath, 'utf-8')).toBe('{"session":"retired"}\n')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'fails in the guest shell when a missing session cannot be linked, then retries cleanly',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'orca-wsl-session-bridge-'))
      const sourceSessionsRoot = join(root, 'legacy', 'sessions')
      const managedSessionsRoot = join(root, 'managed', 'sessions')
      const relativePath = join('2026', '08', '26', 'retired.jsonl')
      const sourcePath = join(sourceSessionsRoot, relativePath)
      const blockingPath = join(managedSessionsRoot, '2026')
      mkdirSync(join(sourcePath, '..'), { recursive: true })
      mkdirSync(managedSessionsRoot, { recursive: true })
      writeFileSync(sourcePath, '{"session":"retired"}\n', 'utf-8')
      writeFileSync(blockingPath, 'not-a-directory\n', 'utf-8')
      const shellCommand = buildWslCodexSessionBridgeShellCommand({
        systemSessionsRoot: sourceSessionsRoot,
        managedSessionsRoot
      })

      try {
        expect(() => execFileSync('/bin/bash', ['-c', shellCommand])).toThrow()
        rmSync(blockingPath)
        execFileSync('/bin/bash', ['-c', shellCommand])
        expect(readFileSync(join(managedSessionsRoot, relativePath), 'utf-8')).toBe(
          '{"session":"retired"}\n'
        )
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  )
})
