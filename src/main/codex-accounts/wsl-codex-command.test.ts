import { describe, expect, it } from 'vitest'
import {
  buildWslCodexAvailabilityArgs,
  buildWslCodexAppServerArgs,
  buildWslCodexIdentityProbe,
  buildWslCodexLoginArgs
} from './wsl-codex-command'
import { CODEX_READ_ONLY_APP_SERVER_ARGS } from '../codex-cli/codex-read-only-app-server-args'

describe('WSL Codex commands', () => {
  it('checks the alias-neutral PATH from the distro login shell', () => {
    const args = buildWslCodexAvailabilityArgs('Ubuntu24-Dev')

    expect(args.slice(0, 5)).toEqual(['-d', 'Ubuntu24-Dev', '--exec', 'sh', '-c'])
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
    expect(command).toContain('exec "$resolved" login')
  })

  it('quotes an explicit read-only app-server contract without changing the default', () => {
    const readOnlyCommand = buildWslCodexAppServerArgs(
      'Ubuntu',
      '/home/alice/managed-home',
      CODEX_READ_ONLY_APP_SERVER_ARGS
    ).at(-1)
    const defaultCommand = buildWslCodexAppServerArgs('Ubuntu', '/home/alice/managed-home').at(-1)

    for (const arg of CODEX_READ_ONLY_APP_SERVER_ARGS) {
      expect(readOnlyCommand).toContain(arg)
    }
    expect(defaultCommand).toContain('app-server')
    expect(defaultCommand).not.toContain('approval_policy=never')
  })

  it('reports the login-shell binary path and version for identity checks', () => {
    const command = buildWslCodexIdentityProbe('Ubuntu').args.at(-1)

    expect(command).toMatch(/printf .*"\$resolved"/)
    expect(command).toContain('exec "$resolved" --version')
  })
})
