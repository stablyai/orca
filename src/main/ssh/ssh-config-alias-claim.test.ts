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

  it('keeps a Host block that names the alias authoritative', () => {
    const config = `
Host *
  ProxyCommand nc %h %p
Host prod
  HostName prod.internal
`
    expect(mayClaim(config, 'prod')).toBe(true)
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
    // `Host * !prod` routes stage; answering false there would licence overriding a block the user
    // wrote. The exempted alias is not worth a second matching rule to recover.
    expect(mayClaim('Host * !prod\n  ForwardAgent yes\n', 'stage')).toBe(true)
    expect(mayClaim('Host * !prod\n  ForwardAgent yes\n', 'prod')).toBe(true)
  })

  it('still proves absence when no group negates', () => {
    expect(mayClaim('Host *\n  ForwardAgent yes\nHost prod\n  User ops\n', 'stage')).toBe(false)
  })

  it('reads an unreadable config as uncertainty, not absence', () => {
    expect(sshConfigMayClaimAlias('prod', null)).toBe(true)
  })

  it('reads an empty alias as uncertainty', () => {
    expect(sshConfigMayClaimAlias('', parseSshConfigAliasClaims('Host *\n'))).toBe(true)
  })
})

describe('parseSshConfigAliasClaims', () => {
  it('retains the raw pattern groups and flags Match blocks', () => {
    expect(
      parseSshConfigAliasClaims('Host a b*  # comment\n  User x\nMatch final\n  User y\n')
    ).toEqual({ hostPatternGroups: [['a', 'b*']], hasMatchBlock: true })
  })
})
