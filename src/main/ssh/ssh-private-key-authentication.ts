import type { AnyAuthMethod, AuthenticationType, ConnectConfig, NextAuthHandler } from 'ssh2'
import type { PrivateKeyFile } from './ssh-auth-resolution'

const passphraseKeyPaths = new WeakMap<ConnectConfig, string>()

// Bounds an `AuthenticationMethods a,b,c` ladder so a host that keeps replying
// "partial success" cannot keep the client prompting forever.
const MAX_PARTIAL_SUCCESS_STAGES = 4

function authMethodName(attempt: AuthenticationType | AnyAuthMethod): AuthenticationType {
  const type = typeof attempt === 'string' ? attempt : attempt.type
  // Agent identities are signed as publickey; a server's method list never names 'agent'.
  return type === 'agent' ? 'publickey' : type
}

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
  if (firstKey) {
    config.privateKey = firstKey.contents
    if (passphraseKeyPath) {
      passphraseKeyPaths.set(config, passphraseKeyPath)
    }
  }

  // Why this replaces ssh2's own handler for every target, not just multi-key ones: ssh2 walks one
  // flat method list exactly once, so keyboard-interactive can only ever be offered a single time.
  // An MFA host running `AuthenticationMethods keyboard-interactive,keyboard-interactive` (or any
  // ladder whose last stage is a second challenge) partial-succeeds the first stage and then finds
  // the list exhausted — reported to the user as "All configured authentication methods failed".
  let queue: (AuthenticationType | AnyAuthMethod)[] = []
  let partialSuccessStagesLeft = MAX_PARTIAL_SUCCESS_STAGES
  config.authHandler = (authsLeft, partialSuccess, next) => {
    if (authsLeft == null) {
      queue = buildAuthQueue(config, keys)
      partialSuccessStagesLeft = MAX_PARTIAL_SUCCESS_STAGES
    } else if (partialSuccess && partialSuccessStagesLeft > 0) {
      // A stage was accepted and the host now demands another method. Restart from a fresh queue
      // narrowed to what it still offers: re-offering keys it has stopped accepting is what
      // exhausts MaxAuthTries before the challenge is ever shown.
      partialSuccessStagesLeft -= 1
      const offered = Array.isArray(authsLeft) ? authsLeft : []
      queue = buildAuthQueue(config, keys).filter((attempt) => {
        const method = authMethodName(attempt)
        return method !== 'none' && offered.includes(method)
      })
    }
    const attempt = queue.shift()
    next((attempt ?? false) as Parameters<NextAuthHandler>[0])
  }
}

export function getPassphrasePrivateKeyPath(config: ConnectConfig): string | undefined {
  return passphraseKeyPaths.get(config)
}
