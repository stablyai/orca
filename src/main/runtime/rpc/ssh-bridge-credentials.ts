/**
 * Short-lived credentials for the `orca` CLI an SSH host runs through this host's bridge.
 *
 * One credential per invocation, bound to the SSH target that relayed it, revoked when the
 * invocation settles. The runtime socket maps it to that target's bridge scope, so the child CLI
 * never holds the owner token.
 */
import { randomBytes } from 'node:crypto'
import type { RpcCallerScope } from './rpc-caller-scope'

export type SshBridgeCallerScope = Extract<RpcCallerScope, { kind: 'ssh-bridge' }>

export type SshBridgeCredential = {
  token: string
  revoke: () => void
}

export class SshBridgeCredentialRegistry {
  private readonly bindings = new Map<string, SshBridgeCallerScope>()

  mint(scope: SshBridgeCallerScope): SshBridgeCredential {
    const token = `sshb_${randomBytes(24).toString('hex')}`
    this.bindings.set(token, { ...scope })
    return { token, revoke: () => this.bindings.delete(token) }
  }

  resolve(token: string): SshBridgeCallerScope | null {
    return this.bindings.get(token) ?? null
  }
}

export const sshBridgeCredentials = new SshBridgeCredentialRegistry()
