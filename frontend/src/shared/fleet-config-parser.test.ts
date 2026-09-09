import { describe, expect, it } from 'vitest'
import { parseFleetConfigFromString } from './fleet-config-parser'

const baseYaml = `
version: '1'
servers:
  - id: srv-1
    label: Server 1
    host: 10.0.0.1
`

describe('fleet-config-parser — vaultSshRole', () => {
  it('parses a server with vaultSshRole set', () => {
    const yaml = `${baseYaml}    vaultSshRole: ci-fleet-role\n`
    const config = parseFleetConfigFromString(yaml)
    expect(config.servers[0].vaultSshRole).toBe('ci-fleet-role')
  })

  it('parses a server with only identityFile (no vaultSshRole) for backward compat', () => {
    const yaml = `${baseYaml}    identityFile: ~/.ssh/id_rsa\n`
    const config = parseFleetConfigFromString(yaml)
    expect(config.servers[0].identityFile).toBe('~/.ssh/id_rsa')
    expect(config.servers[0].vaultSshRole).toBeUndefined()
  })

  it('parses a server with both identityFile and vaultSshRole present together', () => {
    const yaml = `${baseYaml}    identityFile: ~/.ssh/id_rsa\n    vaultSshRole: ci-fleet-role\n`
    const config = parseFleetConfigFromString(yaml)
    expect(config.servers[0].identityFile).toBe('~/.ssh/id_rsa')
    expect(config.servers[0].vaultSshRole).toBe('ci-fleet-role')
  })
})
