import { describe, expect, it } from 'vitest'
import { buildEncodedWslBashCommand } from './wsl-bash-command'

describe('buildEncodedWslBashCommand', () => {
  it('wraps Bash scripts without exposing local shell variables to wsl.exe', () => {
    const command = [
      'set -euo pipefail',
      "candidate='/home/alice/.local/share/orca/codex-accounts/a/home'",
      'candidate_real=$(readlink -f -- "$candidate")',
      'printf "%s\\n" "$candidate_real"'
    ].join('\n')

    const wrapped = buildEncodedWslBashCommand(command)
    const encoded = wrapped.match(
      /^set -o pipefail; printf %s '([^']+)' \| base64 -d \| bash$/
    )?.[1]

    expect(wrapped).not.toContain('$candidate')
    expect(wrapped).not.toContain('\n')
    expect(encoded).toBeTruthy()
    expect(Buffer.from(encoded as string, 'base64').toString('utf8')).toBe(command)
  })
})
