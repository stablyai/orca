import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnProcess } from '@orca/process-host'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { probeRecentClaudeCliVersion } from '../claude/claude-hook-event-versions'
import { resolveGuestNativeAgentCommand, WINDOWS_ONLY_AGENT_CLI_DIR } from './command'

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
  const options = () => ({ pathEnv: `${native}:${drive}/npm`, homePath: join(root, 'home') })

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

  it('leaves a CLI missing everywhere as its bare name, as before', () => {
    expect(resolveGuestNativeAgentCommand('claude', options(), [drive])).toBe('claude')
  })

  it('resolves exactly as before off a WSL host', () => {
    const windowsCopy = install(join(drive, 'npm'), 'claude')
    expect(resolveGuestNativeAgentCommand('claude', options(), [])).toBe(windowsCopy)
  })
})

describe.skipIf(process.platform === 'win32')('callers given a Windows-only CLI', () => {
  const missing = `${WINDOWS_ONLY_AGENT_CLI_DIR}/claude`

  it('see nothing on disk (hook fingerprints, presence checks)', () => {
    expect(existsSync(missing)).toBe(false)
  })

  it('get ENOENT from a spawn (login, rate limits, app-server probes)', async () => {
    const child = spawnProcess({ program: missing, args: ['--version'] })
    const error = await new Promise<NodeJS.ErrnoException>((resolve) => child.on('error', resolve))
    expect(error.code).toBe('ENOENT')
  })

  it('read no version (hook-event and diff-panel version probes)', async () => {
    await expect(probeRecentClaudeCliVersion(missing)).resolves.toBeNull()
  })
})
