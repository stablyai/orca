import { describe, expect, it, vi } from 'vitest'
import {
  formatNostrCloneUrl,
  parseMaintainersYaml,
  parseNostrRemoteUrl
} from './nostr-repository-address'
import { lookupNip05Pubkey } from './nip05-lookup'

const NPUB = 'npub1md8jahxf2u9fh2mlufaa3kjhshn96wm8eqyck7y99fmyd76jwynq99sxe7'
const PUBKEY = 'db4f2edcc9570a9bab7fe27bd8da5785e65d3b67c8098b78852a7646fb527126'

describe('nostr repository addresses', () => {
  it.each([
    [`nostr://${NPUB}/allod`, { pubkey: PUBKEY }, []],
    [`nostr://${NPUB}/relay.ngit.dev/allod`, { pubkey: PUBKEY }, ['wss://relay.ngit.dev']],
    ['nostr://allod.me/relay.ngit.dev/allod', { nip05: 'allod.me' }, ['wss://relay.ngit.dev']],
    ['nostr://me@allod.me/allod', { nip05: 'me@allod.me' }, []],
    [
      `nostr://${NPUB}/wss%3A%2F%2Frelay.ngit.dev/allod`,
      { pubkey: PUBKEY },
      ['wss://relay.ngit.dev']
    ],
    [`https://relay.ngit.dev/${NPUB}/allod.git`, { pubkey: PUBKEY }, ['wss://relay.ngit.dev']]
  ])('reads %s', (url, owner, relayHints) => {
    expect(parseNostrRemoteUrl(url)).toEqual({ owner, identifier: 'allod', relayHints })
  })

  it.each([
    'https://github.com/stablyai/orca.git',
    'git@github.com:stablyai/orca.git',
    'nostr://nobody',
    `https://user@evil.example/${NPUB}/allod.git`
  ])('leaves %s to other forges', (url) => {
    expect(parseNostrRemoteUrl(url)).toBeNull()
  })

  it('round-trips the URL handed to ngit', () => {
    const url = formatNostrCloneUrl(PUBKEY, 'allod', 'wss://relay.ngit.dev')
    expect(url).toBe(`nostr://${NPUB}/relay.ngit.dev/allod`)
    expect(parseNostrRemoteUrl(url)?.owner).toEqual({ pubkey: PUBKEY })
  })

  it('reads maintainers.yaml and ignores one naming nobody', () => {
    expect(
      parseMaintainersYaml(`maintainers:\n  - ${NPUB}\nrelays:\n  - wss://relay.ngit.dev\n`, 'dir')
    ).toEqual({
      owner: { pubkey: PUBKEY },
      identifier: 'dir',
      relayHints: ['wss://relay.ngit.dev']
    })
    expect(parseMaintainersYaml('maintainers: [someone]', 'dir')).toBeNull()
  })

  it('asks only the named https domain for a NIP-05 key, refusing redirects', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ names: { _: PUBKEY } }))
    await expect(lookupNip05Pubkey('allod.me', fetchImpl)).resolves.toBe(PUBKEY)
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://allod.me/.well-known/nostr.json?name=_',
      expect.objectContaining({ redirect: 'error' })
    )
    await expect(lookupNip05Pubkey('x@evil.example/path?', fetchImpl)).resolves.toBeNull()
    await expect(lookupNip05Pubkey('localhost', fetchImpl)).resolves.toBeNull()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
