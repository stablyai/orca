/**
 * Issue #8622 — SSH keyboard-interactive authentication (push-based MFA).
 *
 * Classification: missing capability (feature reported as bug). OpenSSH /
 * VS Code Remote SSH complete password then keyboard-interactive MFA; Orca's
 * ssh2 path never enables tryKeyboard or handles 'keyboard-interactive'.
 *
 * After password prompt, auth fails with the issue's exact message:
 * "All configured authentication methods failed" — MFA prompt is never shown.
 *
 * Re-run:
 *   pnpm exec vitest run --config config/vitest.config.ts \
 *     src/main/ssh/repro-8622-keyboard-interactive-missing.test.ts
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildConnectConfig, isAuthError, type SshCredentialKind } from './ssh-connection-utils'
import type { SshTarget } from '../../shared/ssh-types'

const connectionSource = readFileSync(join(__dirname, 'ssh-connection.ts'), 'utf8')
const utilsSource = readFileSync(join(__dirname, 'ssh-connection-utils.ts'), 'utf8')
const authSource = readFileSync(join(__dirname, 'ssh-auth-resolution.ts'), 'utf8')

describe('#8622 keyboard-interactive auth not implemented (capability gap)', () => {
  it('buildConnectConfig never sets tryKeyboard', () => {
    const target = {
      id: 't1',
      label: 'hpc',
      host: 'hpc.example.edu',
      port: 22,
      username: 'student'
    } as SshTarget
    const config = buildConnectConfig(target, null)
    expect(config).not.toHaveProperty('tryKeyboard')
    expect(utilsSource).not.toMatch(/tryKeyboard/)
    expect(authSource).not.toMatch(/tryKeyboard|keyboard-interactive|keyboardInteractive/)
  })

  it('credential kinds are only passphrase | password (no keyboard-interactive)', () => {
    // Compile-time shape mirrored at runtime via source contract
    const kinds: SshCredentialKind[] = ['passphrase', 'password']
    expect(kinds).toEqual(['passphrase', 'password'])
    expect(utilsSource).toMatch(/export type SshCredentialKind = 'passphrase' \| 'password'/)
    expect(utilsSource).not.toMatch(/keyboard/)
  })

  it('ssh-connection has no keyboard-interactive event handler', () => {
    expect(connectionSource).not.toMatch(/keyboard-interactive/)
    expect(connectionSource).not.toMatch(/keyboardInteractive/)
    expect(connectionSource).not.toMatch(/on\(['"]keyboard/)
    // Password path exists and is the only interactive auth retry after agent fail
    expect(connectionSource).toMatch(/onCredentialRequest\([\s\S]*'password'/s)
  })

  it('classifies the issue failure string as an auth error (surface users see)', () => {
    expect(isAuthError(new Error('All configured authentication methods failed'))).toBe(true)
  })
})
