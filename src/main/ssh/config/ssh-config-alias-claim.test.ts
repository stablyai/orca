import { describe, expect, it } from 'vitest'
import { parseSshConfigAliasClaims } from './ssh-config-parser'
import { sshConfigMayClaimAlias } from './ssh-config-alias-claim'

function mayClaim(config: string, alias: string): boolean {
  return sshConfigMayClaimAlias(alias, parseSshConfigAliasClaims(config))
}

describe('sshConfigMayClaimAlias', () => {
  it('treats a wildcard-only config as proof that nothing claims the alias', () => {
    const config = `
Host *
  ProxyCommand nc -X connect -x proxy:8080 %h %p
  ForwardAgent yes
`
    expect(mayClaim(config, 'prod')).toBe(false)
  })

  it('keeps a glob that reaches the alias authoritative', () => {
    // parseSshConfig drops these, which is why the claim check cannot reuse it.
    const config = `
Host prod-*
  HostName prod.internal
`
    expect(mayClaim(config, 'prod-web')).toBe(true)
    expect(mayClaim(config, 'stage-web')).toBe(false)
  })

  it('matches single-character wildcards the way OpenSSH does', () => {
    expect(mayClaim('Host prod?\n  User ops\n', 'prod1')).toBe(true)
    expect(mayClaim('Host prod?\n  User ops\n', 'prod12')).toBe(false)
  })

  it('refuses to answer once any Match block is present', () => {
    const config = `
Host *
  ProxyCommand nc %h %p
Match host prod
  User ops
`
    expect(mayClaim(config, 'prod')).toBe(true)
  })

  it('reads any negated group as uncertainty, because OpenSSH still applies its positives', () => {
    // Negation makes the group uncertain: ignoring Host * !prod would wrongly permit overriding stage.
    expect(mayClaim('Host * !prod\n  ForwardAgent yes\n', 'stage')).toBe(true)
    expect(mayClaim('Host * !prod\n  ForwardAgent yes\n', 'prod')).toBe(true)
  })
})
