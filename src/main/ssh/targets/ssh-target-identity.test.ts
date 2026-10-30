import { describe, expect, it } from 'vitest'
import { sshRouteKey, type SshRoute } from './ssh-target-identity'

const route = (overrides: Partial<SshRoute> = {}): SshRoute => ({
  alias: 'box',
  host: '10.0.0.5',
  port: 22,
  username: 'deploy',
  ...overrides
})

describe('sshRouteKey', () => {
  it('keeps aliases apart when a shared ProxyCommand names the alias with %n', () => {
    const proxy = { kind: 'proxy-command' as const, command: 'docker exec -i %n nc localhost 22' }

    expect(sshRouteKey(route({ alias: 'dev1', proxy }))).not.toBe(
      sshRouteKey(route({ alias: 'dev2', proxy }))
    )
  })

  it('matches a route whose tokens expand to the same command', () => {
    expect(
      sshRouteKey(route({ proxy: { kind: 'proxy-command', command: 'ssh bastion -W %h:%p' } }))
    ).toBe(
      sshRouteKey(
        route({ proxy: { kind: 'proxy-command', command: 'ssh bastion -W 10.0.0.5:22' } })
      )
    )
  })

  it("keeps %n literal for ssh2, whose proxy spawner doesn't expand it", () => {
    const withToken = route({ proxy: { kind: 'proxy-command', command: 'nc %n 22' } })
    const expanded = route({ proxy: { kind: 'proxy-command', command: 'nc box 22' } })

    expect(sshRouteKey(withToken)).toBe(sshRouteKey(expanded))
    expect(sshRouteKey(withToken, 'ssh2')).not.toBe(sshRouteKey(expanded, 'ssh2'))
  })

  it('keeps a jump host literal for ssh2, whose launcher expands no tokens there', () => {
    const tokenized = route({
      username: 'alice',
      proxy: { kind: 'jump-host', jumpHost: '%r@bastion' }
    })
    const literal = route({
      username: 'alice',
      proxy: { kind: 'jump-host', jumpHost: 'alice@bastion' }
    })

    expect(sshRouteKey(tokenized, 'ssh2')).not.toBe(sshRouteKey(literal, 'ssh2'))
  })

  it('is unknown for ssh2 when a token sits inside quotes, which its launcher shell-quotes again', () => {
    expect(
      sshRouteKey(route({ proxy: { kind: 'proxy-command', command: 'nc "%h" %p' } }), 'ssh2')
    ).toBe('')
  })

  it('is unknown for a token that is not the destination, so it never matches', () => {
    expect(
      sshRouteKey(route({ proxy: { kind: 'proxy-command', command: 'ssh -o Tag=%L bastion' } }))
    ).toBe('')
  })

  it('separates jump hosts and case-distinct users, and folds hostname case', () => {
    const viaA = sshRouteKey(route({ proxy: { kind: 'jump-host', jumpHost: 'bastion-a' } }))

    expect(viaA).not.toBe(
      sshRouteKey(route({ proxy: { kind: 'jump-host', jumpHost: 'bastion-b' } }))
    )
    expect(sshRouteKey(route({ username: 'Admin' }))).not.toBe(
      sshRouteKey(route({ username: 'admin' }))
    )
    expect(sshRouteKey(route({ host: 'BOX.example' }))).toBe(
      sshRouteKey(route({ host: 'box.example' }))
    )
  })
})
