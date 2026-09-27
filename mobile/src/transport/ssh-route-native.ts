import { z } from 'zod'
import {
  assertConnectionRouteActive,
  ConnectionRouteError,
  type ConnectionRouteStage
} from './connection-route'

type SshTunnelModule = {
  create(): string
  open(id: string, config: string): Promise<string>
  probe(id: string, config: string): Promise<string>
  close(id: string): void
}

export async function sshTunnelModule(): Promise<SshTunnelModule> {
  const { requireOptionalNativeModule } = await import('expo-modules-core')
  const module = requireOptionalNativeModule<SshTunnelModule>('OrcaSshTunnel')
  if (!module) {
    throw new ConnectionRouteError(
      'This build does not include SSH tunneling. Install a native Orca build with the SSH module.',
      false
    )
  }
  return module
}

export function sshRouteError(
  error: unknown,
  stages?: ConnectionRouteStage[]
): ConnectionRouteError {
  const message = error instanceof Error ? error.message : ''
  if (message.includes('SSH_HOST_KEY_MISMATCH')) {
    return new ConnectionRouteError(
      'SSH host key changed. Verify the server identity before updating the saved fingerprint.',
      false,
      stages
    )
  }
  if (message.includes('SSH_KEY_INVALID')) {
    return new ConnectionRouteError(
      'Cannot unlock the SSH private key. Check its format and passphrase.',
      false,
      stages
    )
  }
  if (message.includes('SSH_JUMP_CONNECT_FAILED')) {
    return new ConnectionRouteError('Cannot reach the jump host.', true, stages)
  }
  if (message.includes('SSH_JUMP_AUTH_FAILED')) {
    return new ConnectionRouteError('Jump host rejected the credentials.', false, stages)
  }
  if (message.includes('SSH_JUMP_HANDSHAKE_FAILED')) {
    return new ConnectionRouteError('Jump host SSH handshake failed.', true, stages)
  }
  if (message.includes('SSH_JUMP_DIAL_FAILED')) {
    return new ConnectionRouteError(
      'The jump host could not reach the SSH server. Check the server hostname and port as the jump host resolves them.',
      false,
      stages
    )
  }
  if (message.includes('SSH_CONFIG_INVALID') || message.includes('SSH_CREDENTIAL_MISSING')) {
    return new ConnectionRouteError('SSH connection settings are incomplete.', false, stages)
  }
  return new ConnectionRouteError(
    'SSH connection failed. Check the host, credentials and whether TCP forwarding is allowed.',
    true,
    stages
  )
}

export type SshProbeJump = {
  host: string
  port: number
  username: string
  hostKeyFingerprint: string
  password?: string
  privateKey?: string
  passphrase?: string
}

export type SshProbeResult = {
  fingerprint: string
  jumpFingerprint: string
}

// Probe returns the server's host-key fingerprint, and the jump host's when a
// jump is configured. No target credential is ever sent; reaching the server
// through a jump requires the jump's own credentials.
export async function probeSshHost(
  host: string,
  port: number,
  signal: AbortSignal,
  jump?: SshProbeJump
): Promise<SshProbeResult> {
  const module = await sshTunnelModule()
  const id = module.create()
  const close = () => module.close(id)
  signal.addEventListener('abort', close, { once: true })
  try {
    assertConnectionRouteActive(signal)
    const raw = await module.probe(
      id,
      JSON.stringify({
        host,
        port,
        ...(jump
          ? {
              jump: {
                host: jump.host,
                port: jump.port,
                username: jump.username,
                hostKeyFingerprint: jump.hostKeyFingerprint,
                ...(jump.privateKey
                  ? { privateKey: jump.privateKey, passphrase: jump.passphrase ?? '' }
                  : { password: jump.password ?? '' })
              }
            }
          : {})
      })
    )
    return SshProbeResultSchema.parse(JSON.parse(raw))
  } catch (error) {
    throw sshRouteError(error)
  } finally {
    signal.removeEventListener('abort', close)
    close()
  }
}

const SshProbeResultSchema = z.object({
  fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/),
  jumpFingerprint: z.string().max(64)
})
