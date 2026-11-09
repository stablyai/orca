// SSH access to a running workspace: installs or removes one desktop's public key in the VM's
// Orca-managed authorized_keys through the fixed /opt/orca/bin/orca-ssh-keys entry point. The VM's
// sshd listens on loopback only; the desktop reaches it through its own runtime connection.
import { z } from 'zod'
import { LifecycleError, type LifecycleDeps } from './lifecycle'
import { VmCommandError } from './sandbox-vm-commands'
import type { SandboxRow } from './store'

export const SSH_KEYS_COMMAND = '/opt/orca/bin/orca-ssh-keys'
const SSH_KEYS_TIMEOUT_MS = 30_000

/** ed25519 only, one line, a plain comment: nothing sshd would read as key options. */
export const SSH_PUBLIC_KEY = /^ssh-ed25519 [A-Za-z0-9+/]{68} [A-Za-z0-9@._:+-]{1,200}$/

export const SshKeyRequestSchema = z.object({ publicKey: z.string().regex(SSH_PUBLIC_KEY) }).strict()

const SshAccessSchema = z
  .object({
    port: z.number().int().min(1).max(65535),
    user: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/),
    hostKey: z.string().regex(/^ssh-ed25519 [A-Za-z0-9+/]{68}$/)
  })
  .strict()

export type SshAccess = z.infer<typeof SshAccessSchema>

export async function updateSshKey(
  deps: LifecycleDeps,
  row: SandboxRow,
  action: 'add' | 'remove',
  publicKey: string
): Promise<SshAccess> {
  if (row.status !== 'running' || !row.session_id) {
    throw new LifecycleError('conflict', `sandbox_${row.status}`)
  }
  const result = await deps.provider.runCommand(row.session_id, {
    command: SSH_KEYS_COMMAND,
    args: [action],
    env: { ORCA_SSH_PUBLIC_KEY: publicKey },
    timeoutMs: SSH_KEYS_TIMEOUT_MS
  })
  // 3 = this VM's image predates sshd (older golden image); 127 = predates the entry point.
  if (result.exitCode === 3 || result.exitCode === 127) {
    throw new LifecycleError('conflict', 'ssh_unsupported_image')
  }
  if (result.exitCode !== 0) {
    throw new VmCommandError('ssh_keys_failed')
  }
  try {
    return SshAccessSchema.parse(JSON.parse(result.stdout.trim().split('\n').at(-1) ?? ''))
  } catch {
    throw new VmCommandError('ssh_keys_failed')
  }
}
