import {
  utils,
  type AnyAuthMethod,
  type AuthenticationType,
  type ConnectConfig,
  type NextAuthHandler
} from 'ssh2'
import { isPrivateKeyPassphraseError, type PrivateKeyFile } from './ssh-auth-resolution'

const MAX_PARTIAL_SUCCESS_STAGES = 4

type AuthenticationAttempt = AuthenticationType | AnyAuthMethod | false
type Candidate =
  | AuthenticationAttempt
  | { type: 'key-file'; file: PrivateKeyFile }
  | { type: 'prompt-password' }

export type SshAuthenticationSession = {
  isCurrent: () => boolean
  requestCredential: (
    kind: 'passphrase' | 'password',
    detail: string
  ) => Promise<string | null | undefined>
  getPassphrase: (path: string) => string | undefined
  setPassphrase: (path: string, value: string | undefined) => void
  getPassword: () => string | null
  setPassword: (value: string | null) => void
  onPromptStart: () => void
  onPromptEnd: () => void
  onError: (error: unknown) => void
}

type AuthenticationState = {
  session?: SshAuthenticationSession
  lastAttempt?: AuthenticationAttempt
}

const authenticationStates = new WeakMap<ConnectConfig, AuthenticationState>()

function methodName(candidate: Candidate): AuthenticationType {
  if (candidate === false) {
    return 'none'
  }
  const type = typeof candidate === 'object' ? candidate.type : candidate
  if (type === 'agent' || type === 'key-file') {
    return 'publickey'
  }
  return type === 'prompt-password' ? 'password' : type
}

function sendAttempt(next: NextAuthHandler, attempt: AuthenticationAttempt): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ssh2 documents false to end authentication; its typings omit it.
  next(attempt as Parameters<NextAuthHandler>[0])
}

function acceptPassword(state: AuthenticationState): void {
  const attempt = state.lastAttempt
  if (
    attempt &&
    typeof attempt === 'object' &&
    attempt.type === 'password' &&
    typeof attempt.password === 'string'
  ) {
    state.session?.setPassword(attempt.password)
  }
}

export function bindSshAuthenticationSession(
  config: ConnectConfig,
  session: SshAuthenticationSession
): void {
  const state = authenticationStates.get(config)
  if (state) {
    state.session = session
  }
}

export function acceptSshAuthentication(config: ConnectConfig): void {
  const state = authenticationStates.get(config)
  if (state) {
    acceptPassword(state)
  }
}

export function configurePrivateKeyAuthentication(
  config: ConnectConfig,
  keys: PrivateKeyFile[]
): void {
  const state: AuthenticationState = {}
  authenticationStates.set(config, state)
  let queue: Candidate[] = []
  let stagesLeft = MAX_PARTIAL_SUCCESS_STAGES
  let passwordPrompted = false
  const promptedKeys = new Set<string>()

  const buildQueue = (): Candidate[] => {
    const username = config.username ?? ''
    const candidates: Candidate[] = [{ type: 'none', username }]
    const password = state.session ? state.session.getPassword() : config.password
    if (password != null) {
      candidates.push({ type: 'password', username, password })
    }
    if (config.agent) {
      candidates.push({ type: 'agent', username, agent: config.agent })
    }
    for (const file of keys) {
      candidates.push({ type: 'key-file', file })
    }
    if (config.tryKeyboard) {
      candidates.push('keyboard-interactive')
    }
    candidates.push({ type: 'prompt-password' })
    return candidates
  }

  const request = async (
    kind: 'passphrase' | 'password',
    detail: string
  ): Promise<string | null | undefined> => {
    const session = state.session
    if (!session?.isCurrent()) {
      return undefined
    }
    session.onPromptStart()
    try {
      return await session.requestCredential(kind, detail)
    } finally {
      if (session.isCurrent()) {
        session.onPromptEnd()
      }
    }
  }

  const prepareKey = async (file: PrivateKeyFile): Promise<AuthenticationAttempt> => {
    const session = state.session
    if (!session?.isCurrent()) {
      return false
    }
    let passphrase = session.getPassphrase(file.path)
    let parsed = utils.parseKey(file.contents, passphrase)
    if (parsed instanceof Error && isPrivateKeyPassphraseError(parsed)) {
      session.setPassphrase(file.path, undefined)
      if (promptedKeys.has(file.path)) {
        return false
      }
      promptedKeys.add(file.path)
      passphrase = (await request('passphrase', file.path)) ?? undefined
      if (!passphrase || !session.isCurrent()) {
        return false
      }
      parsed = utils.parseKey(file.contents, passphrase)
    }
    if (!session.isCurrent() || parsed instanceof Error) {
      return false
    }
    const privateKey = Array.isArray(parsed) ? parsed.find((key) => key.isPrivateKey()) : parsed
    if (!privateKey?.isPrivateKey()) {
      return false
    }
    // A decrypted key is reusable even when this host does not authorize it.
    if (passphrase) {
      session.setPassphrase(file.path, passphrase)
    }
    return { type: 'publickey', username: config.username ?? '', key: privateKey }
  }

  const prepareNext = async (): Promise<AuthenticationAttempt> => {
    while (queue.length && state.session?.isCurrent()) {
      const candidate = queue.shift()!
      if (typeof candidate === 'object' && candidate.type === 'key-file') {
        const key = await prepareKey(candidate.file)
        if (key) {
          return key
        }
      } else if (typeof candidate === 'object' && candidate.type === 'prompt-password') {
        if (passwordPrompted) {
          continue
        }
        passwordPrompted = true
        const password = await request('password', config.host ?? '')
        if (password != null && state.session?.isCurrent()) {
          return { type: 'password', username: config.username ?? '', password }
        }
      } else {
        return candidate
      }
    }
    return false
  }

  config.authHandler = (methodsLeft, partialSuccess, next) => {
    if (methodsLeft == null) {
      queue = buildQueue()
      stagesLeft = MAX_PARTIAL_SUCCESS_STAGES
      passwordPrompted = false
      promptedKeys.clear()
      state.lastAttempt = undefined
    } else {
      if (partialSuccess) {
        acceptPassword(state)
        if (stagesLeft-- <= 0) {
          sendAttempt(next, false)
          return
        }
        queue = buildQueue()
      } else if (
        state.lastAttempt &&
        typeof state.lastAttempt === 'object' &&
        state.lastAttempt.type === 'password'
      ) {
        state.session?.setPassword(null)
      }
      // Only offer credentials useful to the current authentication stage.
      queue = queue.filter((candidate) => methodsLeft.includes(methodName(candidate)))
    }
    if (state.session) {
      void prepareNext().then(
        (attempt) => {
          if (!state.session?.isCurrent()) {
            return
          }
          state.lastAttempt = attempt
          sendAttempt(next, attempt)
        },
        (error: unknown) => state.session?.onError(error)
      )
      return
    }
    const candidate = queue.shift() ?? false
    if (typeof candidate === 'object' && candidate.type === 'key-file') {
      next({
        type: 'publickey',
        username: config.username ?? '',
        key: candidate.file.contents,
        passphrase: config.passphrase
      })
    } else if (typeof candidate === 'object' && candidate.type === 'prompt-password') {
      sendAttempt(next, false)
    } else {
      sendAttempt(next, candidate)
    }
  }
}
