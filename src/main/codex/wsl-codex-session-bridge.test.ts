import { beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { runWslProcessMock } = vi.hoisted(() => ({
  runWslProcessMock: vi.fn()
}))

vi.mock('../wsl/wsl-runner', () => ({
  runWslProcess: runWslProcessMock
}))

import {
  buildWslCodexSessionBridgeShellCommand,
  resolveWslCodexSessionBridgeLinuxPaths,
  startWslCodexSessionBridgeInBackground,
  syncWslCodexSessionsIntoManagedHome
} from './wsl-codex-session-bridge'

function mockRunWslProcessSuccess(stdout = '{"scannedFiles":2,"linkedFiles":1}\n'): void {
  runWslProcessMock.mockResolvedValue({
    environmentResolved: true,
    code: 0,
    stdout,
    stderr: '',
    timedOut: false
  })
}

beforeEach(() => {
  runWslProcessMock.mockReset()
})

describe('syncWslCodexSessionsIntoManagedHome', () => {
  it('runs a WSL hardlink bridge from the WSL system sessions into the managed home', async () => {
    mockRunWslProcessSuccess()

    const summary = await syncWslCodexSessionsIntoManagedHome({
      distro: 'Ubuntu',
      systemCodexHomePath: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.codex',
      managedCodexHomePath:
        '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.local\\share\\orca\\codex-runtime-home\\home'
    })

    expect(summary).toEqual({ scannedFiles: 2, linkedFiles: 1 })
    expect(runWslProcessMock).toHaveBeenCalledTimes(1)
    const spec = runWslProcessMock.mock.calls[0]?.[0] as {
      distro: string
      loginPath: string
      shell?: string
      script: string
      timeoutMs: number
    }
    expect(spec.distro).toBe('Ubuntu')
    expect(spec.loginPath).toBe('none')
    expect(spec.shell).toBe('bash')
    expect(spec.timeoutMs).toBe(30_000)

    const shellCommand = spec.script
    expect(shellCommand).toContain("source_sessions_root='/home/alice/.codex/sessions'")
    expect(shellCommand).toContain(
      "managed_sessions_root='/home/alice/.local/share/orca/codex-runtime-home/home/sessions'"
    )
    expect(shellCommand).toContain(`find "$source_sessions_root" -type f -name '*.jsonl' -print0`)
    expect(shellCommand).toContain('ln -- "$link_source" "$target_file"')
    expect(shellCommand).toContain('if [ -e "$target_file" ] || [ -L "$target_file" ]; then')
    expect(shellCommand).not.toContain('ln -s')
    expect(shellCommand).toContain('cp --')
    expect(shellCommand).not.toContain('sqlite')
  })

  it('does not invoke WSL when paths are not resolvable inside the distro', async () => {
    const summary = await syncWslCodexSessionsIntoManagedHome({
      distro: 'Ubuntu',
      systemCodexHomePath: 'C:\\Users\\alice\\.codex',
      managedCodexHomePath: 'C:\\Users\\alice\\AppData\\Roaming\\orca\\codex-runtime-home\\home'
    })

    expect(summary).toEqual({ scannedFiles: 0, linkedFiles: 0 })
    expect(runWslProcessMock).not.toHaveBeenCalled()
  })

  it('parses the summary after leading stdout noise', async () => {
    mockRunWslProcessSuccess(
      'Welcome to Ubuntu\nprofile output\n{"scannedFiles":4,"linkedFiles":3}\n'
    )

    const summary = await syncWslCodexSessionsIntoManagedHome({
      distro: 'Ubuntu',
      systemCodexHomePath: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.codex',
      managedCodexHomePath:
        '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.local\\share\\orca\\codex-runtime-home\\home'
    })

    expect(summary).toEqual({ scannedFiles: 4, linkedFiles: 3 })
  })

  it('throws on a non-zero exit so the background wrapper logs and swallows it', async () => {
    runWslProcessMock.mockResolvedValue({
      environmentResolved: true,
      code: 1,
      stdout: '',
      stderr: 'boom',
      timedOut: false
    })

    await expect(
      syncWslCodexSessionsIntoManagedHome({
        distro: 'Ubuntu',
        systemCodexHomePath: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.codex',
        managedCodexHomePath:
          '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.local\\share\\orca\\codex-runtime-home\\home'
      })
    ).rejects.toThrow('WSL codex session bridge failed')
  })

  it('coalesces duplicate background bridges for the same WSL target', async () => {
    mockRunWslProcessSuccess()
    const target = {
      distro: 'Ubuntu',
      systemCodexHomePath: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.codex',
      managedCodexHomePath:
        '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.local\\share\\orca\\codex-runtime-home\\home'
    }

    const firstTask = startWslCodexSessionBridgeInBackground(target)
    const secondTask = startWslCodexSessionBridgeInBackground(target)

    expect(firstTask).toBe(secondTask)
    await firstTask
    expect(runWslProcessMock).toHaveBeenCalledTimes(1)
  })
})

describe('resolveWslCodexSessionBridgeLinuxPaths', () => {
  it('requires both homes to belong to the requested distro', () => {
    expect(
      resolveWslCodexSessionBridgeLinuxPaths({
        distro: 'Ubuntu',
        systemCodexHomePath: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.codex',
        managedCodexHomePath:
          '\\\\wsl.localhost\\Debian\\home\\alice\\.local\\share\\orca\\codex-runtime-home\\home'
      })
    ).toBeNull()
  })

  it('accepts Linux paths for direct script construction tests', () => {
    expect(
      resolveWslCodexSessionBridgeLinuxPaths({
        distro: 'Ubuntu',
        systemCodexHomePath: '/home/alice/.codex',
        managedCodexHomePath: '/home/alice/.local/share/orca/codex-runtime-home/home'
      })
    ).toEqual({
      systemSessionsRoot: '/home/alice/.codex/sessions',
      managedSessionsRoot: '/home/alice/.local/share/orca/codex-runtime-home/home/sessions'
    })
  })
})

describe('buildWslCodexSessionBridgeShellCommand', () => {
  it('only targets JSONL session files under sessions', () => {
    const shellCommand = buildWslCodexSessionBridgeShellCommand({
      systemSessionsRoot: "/home/alice/.codex/sessions with 'quote'",
      managedSessionsRoot: '/home/alice/.local/share/orca/codex-runtime-home/home/sessions'
    })

    expect(shellCommand).toContain(
      `source_sessions_root='/home/alice/.codex/sessions with '\\''quote'\\'''`
    )
    expect(shellCommand).toContain(`-name '*.jsonl'`)
    expect(shellCommand).not.toContain('.sqlite')
  })

  it('keeps Linux-side shell variable expansion intact for the guest shell', () => {
    const shellCommand = buildWslCodexSessionBridgeShellCommand({
      systemSessionsRoot: '/home/alice/.codex/sessions',
      managedSessionsRoot: '/home/alice/.local/share/orca/codex-runtime-home/home/sessions'
    })

    expect(shellCommand).toContain('$source_sessions_root')
    expect(shellCommand).toContain('$source_file')
    expect(shellCommand).toContain('$((scanned_files + 1))')
  })

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
