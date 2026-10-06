import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { setSecretStore, _resetSecretStoreForTests } from '../../shared/secret-store'
import { createIsolatedWslAccountFixture } from './native-wsl-accounts-fixtures'
import { createEncryptedAntigravityAccountStore } from './native-account-store'
import { AntigravityAccountService } from './native-account-service'
import { credential } from './native-account-test-fixtures'

const enabled =
  process.platform === 'win32' &&
  process.env.ORCA_REAL_ANTIGRAVITY_WSL_ACCOUNTS_TEST === '1' &&
  Boolean(process.env.ORCA_WSL_TEST_DISTRO)
describe.skipIf(!enabled)('real Windows to WSL isolated account lifecycle', () => {
  afterEach(() => _resetSecretStoreForTests())
  it('saves, selects, checks launch and removes synthetic accounts without changing normal HOME', async () => {
    const guest = await createIsolatedWslAccountFixture(process.env.ORCA_WSL_TEST_DISTRO ?? '')
    const directory = await mkdtemp(join(tmpdir(), 'orca-agy-wsl-vault-'))
    // Synthetic envelope tests ACL/scope publication; it does not claim real OS encryption coverage.
    setSecretStore({
      isEncryptionAvailable: () => true,
      describeProtectionGap: () => null,
      encryptString: (value) => Buffer.from(`fixture:${Buffer.from(value).toString('base64')}`),
      decryptString: (bytes) => {
        if (!bytes.toString().startsWith('fixture:')) {
          throw new Error('Invalid fixture envelope')
        }
        return Buffer.from(bytes.toString().slice(8), 'base64').toString()
      }
    })
    try {
      const store = createEncryptedAntigravityAccountStore(
        join(directory, guest.authority.authorityId, 'vault'),
        { authority: guest.authority }
      )
      const service = new AntigravityAccountService(store, guest.backend)
      await guest.backend.write(credential('first'), null)
      const first = (await service.addCurrentAccount()).accounts[0]
      if (!first) {
        throw new Error('Missing synthetic first account')
      }
      await guest.backend.write(credential('second'), credential('first'))
      const second = (await service.addCurrentAccount()).accounts.find(
        (account) => account.id !== first.id
      )
      if (!second) {
        throw new Error('Missing synthetic second account')
      }
      await service.selectAccount(first.id)
      await service.prepareForLaunch()
      expect((await guest.backend.read())?.contents).toBe(credential('first'))
      expect(await guest.command('stat -c %a -- "$1"', [guest.authority.credentialPath])).toBe(
        '600'
      )
      expect((await service.removeAccount(second.id)).accounts).toHaveLength(1)
      await guest.verifyUnchanged()
    } finally {
      await guest.clean()
      await rm(directory, { recursive: true, force: true })
    }
  }, 60_000)
  it.skipIf(!process.env.ORCA_WSL_SECOND_TEST_DISTRO)(
    'keeps a second explicit distro unchanged',
    async () => {
      const firstName = process.env.ORCA_WSL_TEST_DISTRO ?? ''
      const secondName = process.env.ORCA_WSL_SECOND_TEST_DISTRO ?? ''
      if (firstName.toLowerCase() === secondName.toLowerCase()) {
        throw new Error('Two different isolated distros are required')
      }
      const first = await createIsolatedWslAccountFixture(firstName)
      const second = await createIsolatedWslAccountFixture(secondName)
      try {
        await first.backend.write(credential('first'), null)
        await second.backend.write(credential('second'), null)
        await first.backend.write(credential('replacement'), credential('first'))
        expect((await second.backend.read())?.contents).toBe(credential('second'))
        await first.verifyUnchanged()
        await second.verifyUnchanged()
      } finally {
        await first.clean()
        await second.clean()
      }
    },
    60_000
  )
})
