import { mkdtemp, rm } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { runWslProcess } from '../wsl/wsl-runner'
import { resolveAntigravityWslTarget } from './native-wsl-account-target'
import {
  withAntigravityAccountOperation,
  remainingAccountOperationMs,
  type AntigravityCredentialBackend,
  AntigravityAccountService
} from './native-account-service'
import {
  buildAntigravityWslCredentialCommand,
  decodeAntigravityWslReply,
  encodeAntigravityWslWrite,
  MAX_WSL_CREDENTIAL_TRANSPORT_BYTES
} from './native-wsl-credential-script'
import { parseAntigravityNativeCredential } from './native-credential-codec'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { setSecretStore, _resetSecretStoreForTests } from '../../shared/secret-store'
import { createEncryptedAntigravityAccountStore } from './native-account-store'
import { credential } from './native-account-test-fixtures'

async function createIsolatedWslAccountFixture(distro: string) {
  const real = await withAntigravityAccountOperation((operation) =>
    resolveAntigravityWslTarget({ runtime: 'wsl', wslDistro: distro }, operation)
  )
  async function command(script: string, args: string[]) {
    const result = await runWslProcess({
      distro: real.distro,
      loginPath: 'none',
      script,
      args,
      timeoutMs: 5000,
      maxOutputBytes: 4096,
      killOnOutputLimit: true
    })
    if (result.code !== 0 || result.timedOut || result.outputTruncated) {
      throw new Error('Isolated WSL fixture command failed')
    }
    return result.stdout.trim()
  }
  const digest = () =>
    command(
      'p="$1/.gemini/antigravity-cli/antigravity-oauth-token"; if [ ! -e "$p" ] && [ ! -L "$p" ]; then printf missing; else [ -f "$p" ] && [ ! -L "$p" ] || exit 1; head -c 65537 -- "$p" | sha256sum | cut -d " " -f 1; fi',
      [real.canonicalHome]
    )
  const before = await digest()
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
    credentialPath: `${home}/.gemini/antigravity-cli/antigravity-oauth-token`
  }
  async function execute(action: 'read' | 'write', input?: string) {
    return withAntigravityAccountOperation(async (operation) => {
      const nonce = randomBytes(16).toString('hex')
      const result = await runWslProcess({
        ...buildAntigravityWslCredentialCommand(action, authority, nonce, operation.deadline),
        distro: real.distro,
        loginPath: 'none',
        input,
        timeoutMs: remainingAccountOperationMs(operation),
        signal: operation.signal,
        maxOutputBytes: MAX_WSL_CREDENTIAL_TRANSPORT_BYTES,
        killOnOutputLimit: true
      })
      if (result.code !== 0 || result.timedOut || result.outputTruncated) {
        throw new Error('Isolated WSL credential operation failed')
      }
      return decodeAntigravityWslReply(result.stdout, nonce)
    })
  }
  const backend: AntigravityCredentialBackend = {
    async read() {
      const reply = await execute('read')
      if (reply.status === 'missing') {
        return null
      }
      if (reply.status !== 'present') {
        throw new Error('Unexpected isolated WSL read reply')
      }
      return parseAntigravityNativeCredential(reply.contents)
    },
    async write(contents, expected) {
      const reply = await execute('write', encodeAntigravityWslWrite(contents, expected))
      if (reply.status !== 'written' || reply.contents !== contents) {
        throw new Error('Unexpected isolated WSL write reply')
      }
    }
  }
  return {
    authority,
    backend,
    command,
    async verifyUnchanged() {
      if ((await digest()) !== before) {
        throw new Error('Normal WSL credentials changed during isolated verification')
      }
    },
    async clean() {
      await command('rm -rf -- "$1"', [home])
      if ((await digest()) !== before) {
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
