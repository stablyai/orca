import { describe, expect, it } from 'vitest'
import {
  buildWslCodexAvailabilityArgs,
  buildWslCodexIdentityArgs,
  buildWslCodexLoginArgs
} from './wsl-codex-command'

describe('WSL Codex commands', () => {
  it('checks the alias-neutral PATH from the distro login shell', () => {
    const args = buildWslCodexAvailabilityArgs('Ubuntu24-Dev')

    expect(args.slice(0, 5)).toEqual(['-d', 'Ubuntu24-Dev', '--', 'sh', '-c'])
    expect(args.at(-1)).toContain('getent passwd')
    expect(args.at(-1)).toContain('_orca_lookup_command=')
    expect(args.at(-1)).toContain('codex')
    expect(args.at(-1)).not.toContain('bash -ic')
  })

  it('launches the resolved Codex executable with its quoted managed home', () => {
    const args = buildWslCodexLoginArgs('Ubuntu', '/home/alice/managed-home')
    const command = args.at(-1)

    expect(command).toContain('export CODEX_HOME=')
    expect(command).toContain('/home/alice/managed-home')
    expect(command).toContain('exec "\\$resolved" login')
  })

  it('reports the login-shell binary path and version for identity checks', () => {
    const command = buildWslCodexIdentityArgs('Ubuntu').at(-1)

    expect(command).toMatch(/printf .*"\\\$resolved"/)
    expect(command).toContain('exec "\\$resolved" --version')
  })
})
