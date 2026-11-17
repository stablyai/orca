import { describe, expect, it } from 'vitest'
import { formatCliError } from '../output/cli-error'
import { RuntimeRpcFailureError } from '../runtime/connection/types'
import { describeRemoteServerSelection } from '../hosts/remote-server-selection'

const notConnected = new RuntimeRpcFailureError({
  id: '1',
  ok: false,
  error: {
    code: 'linear_not_connected',
    message: 'Linear is not connected on this Orca host.',
    data: { nextSteps: ['Connect Linear on this host, then retry the search.'] }
  }
})

function format(flags: [string, string][], env: NodeJS.ProcessEnv = {}): string {
  return formatCliError(notConnected, {
    commandPath: ['linear', 'search'],
    remoteServer: describeRemoteServerSelection(new Map(flags), env)
  })
}

describe('linear_not_connected recovery', () => {
  it('names the paired server and repeats its flag in the connect command', () => {
    const text = format([['environment', 'build-vm']])
    expect(text).toContain('selected by --environment build-vm')
    expect(text).toMatch(/\| \S+ linear connect --environment build-vm\n/)
    expect(text).toContain('Next step: Connect Linear on this host, then retry the search.')
  })

  it('quotes a server name the shell would split', () => {
    expect(format([['environment', 'Build VM']])).toMatch(
      /linear connect --environment ['"]Build VM['"]\n/
    )
  })

  it('names an inherited ORCA_ENVIRONMENT without repeating a flag', () => {
    const text = format([], { ORCA_ENVIRONMENT: 'build-vm' })
    expect(text).toContain('selected by ORCA_ENVIRONMENT=build-vm')
    expect(text).toMatch(/\| \S+ linear connect\n/)
  })

  it('follows an explicit runtime host over an ambient pairing code', () => {
    const text = format([['host', 'runtime:env-2']], { ORCA_PAIRING_CODE: 'orca://pair?code=x' })
    expect(text).toContain('selected by --host runtime:env-2')
    expect(text).toMatch(/linear connect --environment env-2\n/)
  })

  it('never echoes a pairing code', () => {
    const text = format([['pairing-code', 'orca://pair?code=secret']])
    expect(text).not.toContain('secret')
    expect(text).toContain('linear connect --pairing-code <same code>')
  })

  it('adds nothing for the local host or an explicit local route', () => {
    const expected =
      'Linear is not connected on this Orca host.\nNext step: Connect Linear on this host, then retry the search.'
    expect(format([])).toBe(expected)
    expect(format([['environment', 'local']], { ORCA_ENVIRONMENT: 'build-vm' })).toBe(expected)
  })
})
