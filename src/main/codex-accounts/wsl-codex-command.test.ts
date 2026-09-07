import { describe, expect, it } from 'vitest'
import {
  buildWslCodexAvailabilityScript,
  buildWslCodexAppServerArgs,
  buildWslCodexIdentityProbe,
  buildWslCodexLoginArgs
} from './wsl-codex-command'
import { CODEX_READ_ONLY_APP_SERVER_ARGS } from '../codex-cli/codex-read-only-app-server-args'

describe('WSL Codex commands', () => {
  // The distro argv and the login-shell PATH are the runner's now (its probe
  // lane caches the same getent-resolved login environment); only the
  // alias-neutral lookup is still this module's to get right.
  it('checks the alias-neutral PATH the runner supplies', () => {
    const script = buildWslCodexAvailabilityScript()

    expect(script).toContain('_orca_lookup_command=')
    expect(script).toContain("'codex'")
    expect(script).toContain('[ -n "$resolved" ]')
    expect(script).not.toContain('bash -ic')
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
