import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveGuestNativeAgentCommand, WINDOWS_ONLY_AGENT_CLI_DIR } from './command'

vi.mock('../../shared/system-cli-install-dirs', () => ({
  getSystemCliInstallDirectories: () => []
}))

let root: string
let native: string
let drive: string

function install(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true })
  const program = join(dir, name)
  writeFileSync(program, '#!/bin/sh\necho "9.9.9 (Claude Code)"\n')
  chmodSync(program, 0o755)
  return program
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-agent-cli-guest-'))
  native = join(root, 'home', '.local', 'bin')
  // Stands in for a Windows drive mount such as /mnt/c.
  drive = join(root, 'c')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('agent CLI resolution on a WSL host', () => {
  const options = () => ({
    pathEnv: `${native}:${drive}/npm`,
    homePath: join(root, 'home'),
    platform: 'linux' as const
  })

  it.each(['claude', 'codex'])('takes the WSL install of %s over a Windows copy', (name) => {
    const own = install(native, name)
    install(join(drive, 'npm'), name)
    expect(resolveGuestNativeAgentCommand(name, options(), [drive])).toBe(own)
  })

  it.each(['claude', 'codex'])(
    'reads a Windows-only %s as not installed: never a bare name the spawn would find',
    (name) => {
      install(join(drive, 'npm'), name)
      expect(resolveGuestNativeAgentCommand(name, options(), [drive])).toBe(
        `${WINDOWS_ONLY_AGENT_CLI_DIR}/${name}`
      )
    }
  )
})
