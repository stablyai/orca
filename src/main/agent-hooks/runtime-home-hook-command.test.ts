import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getManagedCommand, getRemoteManagedCommand } from '../claude/hook-settings'
import { createManagedCommandMatcher } from './installer-utils'
import { wrapRuntimeHomeHookCommand } from './runtime-home-hook-command'

function posixHookTestShell(): string | null {
  if (process.platform !== 'win32') {
    return '/bin/sh'
  }
  const gitBash = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe')
  return existsSync(gitBash) ? gitBash : null
}

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'orca-runtime-home-hook-'))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('wrapRuntimeHomeHookCommand POSIX install', () => {
  // Why: Grok load-time-expands bare $VAR across the whole command string, including a
  // Windows branch this host never takes (#17202 residual of #14794 / #14994).
  it.skipIf(process.platform === 'win32')(
    'does not mention SYSTEMROOT or powershell in the command Grok scans',
    () => {
      const command = getManagedCommand(`${tmpDir}/claude-hook.sh`)

      expect(command).not.toMatch(/SYSTEMROOT/i)
      expect(command).not.toMatch(/powershell/i)
      expect(command).not.toContain('.cmd')
      expect(command).not.toContain('msys*')
      expect(command).toContain('/bin/sh "${HOME-}/.orca/agent-hooks/claude-hook.sh"')
      expect(command).not.toMatch(/\$(?!\{)[A-Za-z_]/)
      expect(command).not.toMatch(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/)
    }
  )

  it('includeWindowsBranch:false never mentions SYSTEMROOT so a static precheck cannot reject it', () => {
    const command = wrapRuntimeHomeHookCommand('claude-hook', { includeWindowsBranch: false })

    expect(command).not.toMatch(/SYSTEMROOT/i)
    expect(command).not.toMatch(/powershell/i)
    expect(command).not.toContain('.cmd')
    expect(command).toContain('/bin/sh "${HOME-}/.orca/agent-hooks/claude-hook.sh"')
    expect(command).not.toMatch(/\$(?!\{)[A-Za-z_]/)
    expect(command).not.toMatch(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/)
  })

  it('omits SYSTEMROOT from the SSH/WSL remote command', () => {
    const command = getRemoteManagedCommand('/home/dev/.orca/agent-hooks/claude-hook.sh')

    expect(command).not.toMatch(/SYSTEMROOT/i)
    expect(command).not.toMatch(/powershell/i)
    expect(command).toContain('/bin/sh "${HOME-}/.orca/agent-hooks/claude-hook.sh"')
  })

  it('sweeps the POSIX-only command with the existing script-name matcher', () => {
    const match = createManagedCommandMatcher('claude-hook.sh')
    const command = wrapRuntimeHomeHookCommand('claude-hook', { includeWindowsBranch: false })

    expect(match(command)).toBe(true)
  })

  // Why: native Windows has no /bin/sh; Git Bash is the same interpreter installer-utils uses.
  it.skipIf(posixHookTestShell() === null)(
    'runs the destination HOME POSIX script when the Windows branch is omitted',
    () => {
      const shell = posixHookTestShell()
      expect(shell).not.toBeNull()
      const destinationHome = join(tmpDir, 'destination profile')
      const scriptDir = join(destinationHome, '.orca', 'agent-hooks')
      mkdirSync(scriptDir, { recursive: true })
      writeFileSync(join(scriptDir, 'claude-hook.sh'), '#!/bin/sh\nexit 7\n', 'utf-8')
      chmodSync(join(scriptDir, 'claude-hook.sh'), 0o755)

      const result = spawnSync(
        shell!,
        ['-c', wrapRuntimeHomeHookCommand('claude-hook', { includeWindowsBranch: false })],
        {
          env: { ...process.env, HOME: destinationHome.replaceAll('\\', '/') }
        }
      )

      expect(result.error).toBeUndefined()
      expect(result.status, result.stderr.toString()).toBe(7)
    }
  )
})
