import { describe, expect, it } from 'vitest'
import { WslOrcadOtherAccountServerError } from '../orcad/wsl-orcad-account-facts'
import { retryableConnectFailure } from './wsl-host-connect-failure'
import { connectForWslHostAdd } from './wsl-host-first-connect'
import { accountHoldingKey } from './wsl-host-account-migration'

const refusal = new WslOrcadOtherAccountServerError(
  'Ubuntu-24.04',
  { uid: '0', name: 'root' },
  { uid: '1000', name: 'alice' }
)

// #49180: another account's server on the port waits on the user; nothing retries into it.
describe('another Linux account holding a WSL host port', () => {
  it('is final for runtime calls, so liveness and panes stop retrying it', () => {
    expect(retryableConnectFailure('Ubuntu-24.04', refusal)).toBe(refusal)
  })

  it('refuses an Add with its own copy, naming the account and port', async () => {
    const result = await connectForWslHostAdd(
      {
        connect: async () => {
          throw refusal
        },
        disconnect: async () => {},
        releaseHolder: async () => {}
      },
      'Ubuntu-24.04',
      () => null
    )
    expect(result).toMatchObject({
      ok: false,
      errorCode: 'otherAccountServer',
      errorParams: { distro: 'Ubuntu-24.04', user: 'root', port: '6768' }
    })
  })
})

describe('finding the account behind an unpinned host', () => {
  it('pins only the one account whose orcad holds the paired key', () => {
    const keys = 'root AAAA\nalice BBBB\n'
    expect(accountHoldingKey(keys, 'AAAA')).toBe('root')
    expect(accountHoldingKey(keys, 'CCCC')).toBeNull()
    expect(accountHoldingKey(`${keys}bob AAAA\n`, 'AAAA')).toBeNull()
    expect(accountHoldingKey('-x AAAA\n', 'AAAA')).toBeNull()
  })
})
