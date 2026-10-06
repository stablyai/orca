import { createHash, randomBytes } from 'node:crypto'
import { runWslProcess } from '../wsl/wsl-runner'
import { resolveAntigravityWslTarget } from './native-wsl-account-target'
import {
  withAntigravityAccountOperation,
  remainingAccountOperationMs
} from './native-account-operation'
import { buildAntigravityWslCredentialCommand } from './native-wsl-credential-script'
import {
  decodeAntigravityWslReply,
  encodeAntigravityWslWrite,
  MAX_WSL_CREDENTIAL_TRANSPORT_BYTES
} from './native-wsl-credential-protocol'
import { parseAntigravityNativeCredential } from './native-credential-codec'
import type { AntigravityCredentialBackend } from './native-account-service'

export async function createIsolatedWslAccountFixture(distro: string) {
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
