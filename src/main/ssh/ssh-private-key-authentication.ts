import {
  utils,
  type AnyAuthMethod,
  type AuthenticationType,
  type ConnectConfig,
  type NextAuthHandler,
  type ParsedKey
} from 'ssh2'
import type { PrivateKeyFile } from './ssh-auth-resolution'

const passphraseKeyPaths = new WeakMap<ConnectConfig, string>()

function buildAuthQueue(
  config: ConnectConfig,
  keys: PrivateKeyFile[]
): (AuthenticationType | AnyAuthMethod)[] {
  const username = config.username ?? ''
  const queue: (AuthenticationType | AnyAuthMethod)[] = [{ type: 'none', username }]
  if (config.password != null) {
    queue.push({ type: 'password', username, password: config.password })
  }
  for (const key of keys) {
    queue.push({
      type: 'publickey',
      username,
      key: key.contents,
      passphrase: config.passphrase
    })
  }
  if (config.agent) {
    queue.push({ type: 'agent', username, agent: config.agent })
  }
  if (config.tryKeyboard) {
    queue.push('keyboard-interactive')
  }
  return queue
}

function isUsableAsEagerPrivateKey(key: PrivateKeyFile, passphrase?: string | Buffer): boolean {
  const parsed = utils.parseKey(key.contents, passphrase) as ParsedKey | ParsedKey[] | Error
  if (parsed instanceof Error) {
    return false
  }
  // Why: ssh2 keeps only the first entry of a multi-key parse (client.js `privateKey[0]`).
  const eager = Array.isArray(parsed) ? parsed[0] : parsed
  return typeof eager?.isPrivateKey === 'function' && eager.isPrivateKey()
}

// Why: ssh2's Client.connect parses config.privateKey before any auth runs and
// throws on an encrypted/unparseable one, so seeding it with the first candidate
// would abort the connect instead of letting authHandler try the other keys.
// Falling back to keys[0] keeps the passphrase prompt for an encrypted-only list.
// `config.passphrase` is still unset here on the first connect — callers only fill
// it after a prompt — so an encrypted key can only be picked on a retry pass.
function selectEagerPrivateKey(config: ConnectConfig, keys: PrivateKeyFile[]): PrivateKeyFile {
  return keys.find((key) => isUsableAsEagerPrivateKey(key, config.passphrase)) ?? keys[0]!
}

export function configurePrivateKeyAuthentication(
  config: ConnectConfig,
  keys: PrivateKeyFile[],
  passphraseKeyPath?: string
): void {
  if (keys.length === 0) {
    return
  }
  config.privateKey = selectEagerPrivateKey(config, keys).contents
  if (passphraseKeyPath) {
    passphraseKeyPaths.set(config, passphraseKeyPath)
  }
  if (keys.length === 1) {
    return
  }

  let queue: (AuthenticationType | AnyAuthMethod)[] = []
  config.authHandler = (authsLeft, _partialSuccess, next) => {
    if (authsLeft == null) {
      queue = buildAuthQueue(config, keys)
    }
    const attempt = queue.shift()
    next((attempt ?? false) as Parameters<NextAuthHandler>[0])
  }
}

export function getPassphrasePrivateKeyPath(config: ConnectConfig): string | undefined {
  return passphraseKeyPaths.get(config)
}
