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

  it('keeps semicolons and spaces intact inside the encoded payload regardless of local shell vars', () => {
    const command = 'echo one; echo two three'
    const wrapped = buildEncodedWslBashCommand(command)

    // buildEncodedWslBashCommand itself emits a literal `set -o pipefail;`
    // prefix before the payload — the safety property under test is that the
    // *caller's* script, not this wrapper's own control statement, survives
    // as opaque Base64 rather than being re-parsed. See
    // skill-discovery-wsl.test.ts for a test that this wrapper string reaches
    // wsl.exe as a single argv element in the real execFile call.
    const encoded = /printf %s '([^']+)'/.exec(wrapped)?.[1]
    expect(encoded).toBeTruthy()
    const decoded = Buffer.from(encoded as string, 'base64').toString('utf8')
    expect(decoded).toBe(command)
    expect(decoded).toContain(';')
  })
})
