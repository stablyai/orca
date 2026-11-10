import type { SshConnectionState } from '../../../shared/ssh-types'

export type SshCredentialKind = 'passphrase' | 'password' | 'keyboard-interactive'

export type SshConnectionCallbacks = {
  onStateChange: (targetId: string, state: SshConnectionState) => void
  // Preserve RFC4256 echo flags so the UI hides secret challenge responses.
  onCredentialRequest?: (
    targetId: string,
    kind: SshCredentialKind,
    detail: string,
    echo?: boolean,
    signal?: AbortSignal
  ) => Promise<string | null>
}
