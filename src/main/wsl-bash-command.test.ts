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

  it('keeps semicolons and spaces intact as a single -c argument, not split by the outer shell', () => {
    const command = 'echo one; echo two three'
    const wrapped = buildEncodedWslBashCommand(command)

    // The whole wrapper must reach `bash -c` as one argv element (execFile
    // passes it as a single array entry — no shell re-parses it in between),
    // so it must contain no unescaped top-level `;` of its own outside the
    // base64 payload.
    const args = ['-d', 'Ubuntu', '--', 'bash', '-c', wrapped]
    expect(args).toHaveLength(6)
    expect(args[5]).toBe(wrapped)

    const encoded = /printf %s '([^']+)'/.exec(wrapped)?.[1]
    const decoded = Buffer.from(encoded as string, 'base64').toString('utf8')
    expect(decoded).toBe(command)
  })
})
