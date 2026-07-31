import type { AnyAuthMethod, AuthenticationType, ConnectConfig, NextAuthHandler } from 'ssh2'
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

export function configurePrivateKeyAuthentication(
  config: ConnectConfig,
  keys: PrivateKeyFile[],
  passphraseKeyPath?: string
): void {
  const firstKey = keys[0]
  if (!firstKey) {
    return
  }
  config.privateKey = firstKey.contents
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
