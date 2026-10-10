import { mkdtemp, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { runWslProcess } from '../wsl/wsl-runner'
import { resolveAntigravityWslTarget } from './native-wsl-account-target'
import {
  withAntigravityAccountOperation,
  AntigravityAccountService
} from './native-account-service'
import { createAntigravityWslCredentialBackend } from './native-wsl-credential-backend'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { setSecretStore, _resetSecretStoreForTests } from '../../shared/secret-store'
import { createEncryptedAntigravityAccountStore } from './native-account-store'
import { credential } from './native-account-test-fixtures'

async function createIsolatedWslAccountFixture(distro: string) {
  const real = await withAntigravityAccountOperation((operation) =>
    resolveAntigravityWslTarget({ runtime: 'wsl', wslDistro: distro }, operation)
  )
  async function command(script: string, args: string[], input?: string) {
    const result = await runWslProcess({
      distro: real.distro,
      loginPath: 'none',
      script,
      args,
      input,
      timeoutMs: 5000,
      maxOutputBytes: 4096,
      killOnOutputLimit: true
    })
    if (result.code !== 0 || result.timedOut || result.outputTruncated) {
      throw new Error('Isolated WSL fixture command failed')
    }
    return result.stdout.trim()
  }
  const normalHomeState = () =>
    command(
      'p="$1/.gemini/antigravity-cli/antigravity-oauth-token"; if [ ! -e "$p" ] && [ ! -L "$p" ]; then printf missing; else stat -c "%d:%i:%u:%a:%h:%s:%y:%z" -- "$p"; fi',
      [real.canonicalHome]
    )
  const before = await normalHomeState()
  const home = await command('umask 077; mktemp -d "$1/.orca-agy-acceptance.XXXXXXXXXXXX"', [
    real.canonicalHome
  ])
  const prefix = `${real.canonicalHome}/.orca-agy-acceptance.`
  if (!home.startsWith(prefix) || !/^[A-Za-z0-9]{12}$/.test(home.slice(prefix.length))) {
    throw new Error('Unsafe isolated WSL HOME')
  }
  const authority = {
    ...real,
    home,
    canonicalHome: home,
    authorityId: createHash('sha256')
      .update(JSON.stringify(['fixture-v1', real.authorityId, home]))
      .digest('hex'),
    credentialPath: posix.join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
  }
  return {
    authority,
    backend: createAntigravityWslCredentialBackend(authority),
    command,
    async simulateNativeSignIn(contents: string) {
      await command(
        'set -eu; umask 077; HOME=$1; export HOME; [ -d "$HOME" ] && [ ! -L "$HOME" ] || exit 1; mkdir -m 700 -p "$HOME/.gemini/antigravity-cli"; cat > "$HOME/.gemini/antigravity-cli/antigravity-oauth-token"; chmod 600 "$HOME/.gemini/antigravity-cli/antigravity-oauth-token"',
        [home],
        contents
      )
    },
    async verifyUnchanged() {
      if ((await normalHomeState()) !== before) {
        throw new Error('Normal WSL credentials changed during isolated verification')
      }
    },
    async clean() {
      await command('rm -rf -- "$1"', [home])
      if ((await normalHomeState()) !== before) {
        throw new Error('Normal WSL credentials changed during isolated cleanup')
      }
    }
  }
}

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
      await expect(guest.backend.write(credential('first'), null)).rejects.toThrow(
        'cannot safely switch'
      )
      expect(await guest.backend.read()).toBeNull()
      await guest.simulateNativeSignIn(credential('first'))
      const first = (await service.addCurrentAccount()).accounts[0]
      if (!first) {
        throw new Error('Missing synthetic first account')
      }
      await guest.simulateNativeSignIn(credential('second'))
      const second = (await service.addCurrentAccount()).accounts.find(
        (account) => account.id !== first.id
      )
      if (!second) {
        throw new Error('Missing synthetic second account')
      }
      await service.selectAccount(second.id)
      await expect(service.selectAccount(first.id)).rejects.toThrow('cannot safely switch')
      expect((await guest.backend.read())?.contents).toBe(credential('second'))
      expect((await service.listAccounts()).selectedAccountId).toBe(second.id)
      await guest.simulateNativeSignIn(credential('first', 2))
      await service.selectAccount(first.id)
      await service.prepareForLaunch()
      expect((await guest.backend.read())?.contents).toBe(credential('first', 2))
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
        await first.simulateNativeSignIn(credential('first'))
        await second.simulateNativeSignIn(credential('second'))
        await expect(
          first.backend.write(credential('replacement'), credential('first'))
        ).rejects.toThrow('cannot safely switch')
        expect((await first.backend.read())?.contents).toBe(credential('first'))
        await first.simulateNativeSignIn(credential('replacement'))
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
