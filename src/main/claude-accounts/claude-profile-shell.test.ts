import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { bindClaudeProfileTerminalEnvironment } from './claude-profile-cli'

it.skipIf(process.platform === 'win32')('restores profile authority after shell rc exports', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-profile-shell-'))
  try {
    const rc = join(dir, 'bashrc')
    const cli = join(dir, 'claude')
    writeFileSync(
      rc,
      'export CLAUDE_CONFIG_DIR=/wrong ANTHROPIC_API_KEY=wrong CLAUDE_CODE_USE_BEDROCK=1\n'
    )
    writeFileSync(
      cli,
      '#!/bin/sh\nprintf "%s|%s|%s" "$CLAUDE_CONFIG_DIR" "${ANTHROPIC_API_KEY-unset}" "${CLAUDE_CODE_USE_BEDROCK-unset}"\n',
      { mode: 0o700 }
    )
    const command = bindClaudeProfileTerminalEnvironment(`'${cli}'`, {
      isolatedCredentials: true,
      configDir: `${dir}/account with spaces`
    })!
    const output = execFileSync('/bin/bash', ['--rcfile', rc, '-ic', command], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
    expect(output).toBe(`${dir}/account with spaces|unset|unset`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
