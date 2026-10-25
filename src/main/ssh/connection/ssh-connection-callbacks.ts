import type { SshConnectionState } from '../../../shared/ssh-types'

export type SshCredentialKind = 'passphrase' | 'password' | 'keyboard-interactive'

export type SshConnectionCallbacks = {
  onStateChange: (targetId: string, state: SshConnectionState) => void
  // Why: echo carries the server's RFC 4256 echo flag for keyboard-interactive
  // prompts so the UI knows whether the typed response may be shown.
  onCredentialRequest?: (
    targetId: string,
    kind: SshCredentialKind,
    detail: string,
    echo?: boolean,
    signal?: AbortSignal
  ) => Promise<string | null>
}
