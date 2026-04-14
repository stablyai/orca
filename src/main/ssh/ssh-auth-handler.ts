import { readFileSync } from 'fs'
import {
  findDefaultKeyFile,
  sleep,
  AUTH_CHALLENGE_TIMEOUT_MS,
  type SshConnectionCallbacks
} from './ssh-connection-utils'
import type { AuthHandlerState } from './ssh-connect-config'

export function createAuthHandler(
  effectiveUser: string,
  effectiveIdentityFile: string | undefined,
  targetId: string,
  callbacks: SshConnectionCallbacks,
  authState: AuthHandlerState
) {
  return (
    methodsLeft: string[] | null,
    _partialSuccess: boolean,
    callback: (config: never) => void
  ) => {
    // ssh2 passes null on the first call, meaning "try whatever you want".
    const methods = methodsLeft ?? ['publickey', 'keyboard-interactive', 'password']

    if (methods.includes('publickey') && process.env.SSH_AUTH_SOCK && !authState.agentAttempted) {
      authState.agentAttempted = true
      callback({
        type: 'agent' as const,
        agent: process.env.SSH_AUTH_SOCK,
        username: effectiveUser
      } as never)
      return
    }

    if (methods.includes('publickey') && effectiveIdentityFile && !authState.keyAttempted) {
      authState.keyAttempted = true
      try {
        callback({
          type: 'publickey' as const,
          username: effectiveUser,
          key: readFileSync(effectiveIdentityFile)
        } as never)
        return
      } catch {
        // Key file unreadable -- fall through to next method
      }
    }

    // Why: users with keys in standard locations but no SSH agent and no
    // explicit identityFile would fail. Probing default paths matches VS Code.
    if (methods.includes('publickey') && !authState.defaultKeyAttempted) {
      authState.defaultKeyAttempted = true
      const defaultKey = findDefaultKeyFile()
      if (defaultKey) {
        callback({
          type: 'publickey' as const,
          username: effectiveUser,
          key: defaultKey.contents
        } as never)
        return
      }
    }

    if (methods.includes('keyboard-interactive')) {
      callback({
        type: 'keyboard-interactive' as const,
        username: effectiveUser,
        prompt: async (
          _name: string,
          instructions: string,
          _lang: string,
          prompts: { prompt: string; echo: boolean }[],
          finish: (responses: string[]) => void
        ) => {
          authState.setState('auth-challenge')
          const timeoutPromise = sleep(AUTH_CHALLENGE_TIMEOUT_MS).then(() => null)
          const responsePromise = callbacks.onAuthChallenge({
            targetId,
            name: _name,
            instructions,
            prompts
          })
          const responses = await Promise.race([responsePromise, timeoutPromise])
          finish(responses ?? [])
        }
      } as never)
      return
    }

    if (methods.includes('password')) {
      callbacks
        .onPasswordPrompt(targetId)
        .then((password) => {
          if (password === null) {
            authState.setState('auth-failed', 'Authentication cancelled')
            callback(false as never)
            return
          }
          callback({
            type: 'password' as const,
            username: effectiveUser,
            password
          } as never)
        })
        .catch(() => {
          callback(false as never)
        })
      return
    }

    authState.setState('auth-failed', 'No supported authentication methods')
    callback(false as never)
  }
}
