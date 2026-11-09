// Wake on SSH for Orca Cloud workspaces. Sets up a per-workspace SSH host entry whose ProxyCommand
// wakes the VM through the control plane (scoped per-sandbox secret, not the user's Orca token),
// then tunnels ssh over the VM's wss bridge to a loopback, key-only sshd. `ssh -F <config> <host>`
// works from any terminal, even while the workspace sleeps.
import { execFile } from 'node:child_process'
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { ipcMain } from 'electron'
import {
  ORCA_CLOUD_SSH_CHANNELS as CH,
  type CloudSshPrepared,
  type CloudTransferResult
} from '../../shared/hosted-sandbox/cloud-transfer-api'
import { isEnvironmentProviderError } from '../environment-providers/environment-provider-driver'
import type { HostedSandboxControlPlaneClient } from './hosted-sandbox-control-plane-client'
import { CLOUD_SSH_PROXY_SCRIPT } from './cloud-ssh-proxy-script'
import { findCloudRuntime } from './hosted-workspace-service'

const run = promisify(execFile)
/** Login user when the control plane does not say (older control planes; Amazon Linux images). */
const DEFAULT_VM_USER = 'vercel-sandbox'

/** Host alias for a workspace: stable, shell- and ssh_config-safe. */
export function cloudSshHostAlias(workspaceName: string | undefined, sandboxId: string): string {
  const slug = (workspaceName ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return `orca-cloud-${slug || sandboxId.slice(4, 12)}`
}

const quote = (value: string): string => `"${value.replace(/(["\\])/g, '\\$1')}"`

/** One `Host` block; the file holds one block per set-up workspace. */
export function renderSshHostBlock(args: {
  alias: string
  user?: string
  identityFile: string
  knownHostsFile: string
  nodeBinary: string
  proxyScript: string
  wakeUrl: string
  secretFile: string
}): string {
  return [
    `Host ${args.alias}`,
    `  HostName ${args.alias}`,
    `  User ${args.user ?? DEFAULT_VM_USER}`,
    `  IdentityFile ${quote(args.identityFile)}`,
    '  IdentitiesOnly yes',
    `  UserKnownHostsFile ${quote(args.knownHostsFile)}`,
    // ELECTRON_RUN_AS_NODE: the app's own runtime runs the proxy; no system Node needed.
    `  ProxyCommand env ELECTRON_RUN_AS_NODE=1 ${quote(args.nodeBinary)} ${quote(args.proxyScript)} ${args.wakeUrl} ${quote(args.secretFile)}`,
    '  ServerAliveInterval 30',
    ''
  ].join('\n')
}

/** Replaces the alias's block (if any) and keeps the others. */
export function upsertSshHostBlock(config: string, alias: string, block: string): string {
  const blocks = config
    .split(/\n(?=Host )/)
    .filter((b) => b.trim() && !b.startsWith(`Host ${alias}\n`))
  return [...blocks.map((b) => (b.endsWith('\n') ? b : `${b}\n`)), block].join('\n')
}

export function installCloudSshHandlers(deps: {
  userDataPath: string
  client: HostedSandboxControlPlaneClient
  /** Electron binary (run as node for the ProxyCommand). */
  nodeBinary?: string
}): () => void {
  const dir = join(deps.userDataPath, 'cloud-ssh')
  ipcMain.removeHandler(CH.prepare)
  ipcMain.handle(
    CH.prepare,
    async (
      _event,
      args: { workspaceId: string }
    ): Promise<CloudTransferResult<CloudSshPrepared>> => {
      const found = findCloudRuntime(deps.userDataPath, args.workspaceId)
      if (!found) {
        return { ok: false, code: 'not_cloud', message: 'Not an Orca Cloud workspace.' }
      }
      try {
        await mkdir(dir, { recursive: true, mode: 0o700 })
        await chmod(dir, 0o700)
        const key = join(dir, 'id_ed25519')
        if (
          !(await stat(key).then(
            () => true,
            () => false
          ))
        ) {
          await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'orca-cloud', '-f', key])
        }
        const publicKey = (await readFile(`${key}.pub`, 'utf8'))
          .trim()
          .split(/\s+/)
          .slice(0, 2)
          .join(' ')
        const { wakeUrl, wakeSecret, user } = await deps.client.setupSsh(found.sandboxId, publicKey)
        const secretFile = join(dir, `${found.sandboxId}.secret`)
        await writeFile(secretFile, wakeSecret, { mode: 0o600 })
        const proxyScript = join(dir, 'orca-cloud-ssh-proxy.cjs')
        await writeFile(proxyScript, CLOUD_SSH_PROXY_SCRIPT, { mode: 0o600 })
        const alias = cloudSshHostAlias(found.runtime.workspaceName, found.sandboxId)
        const configPath = join(dir, 'config')
        const current = await readFile(configPath, 'utf8').catch(() => '')
        const block = renderSshHostBlock({
          alias,
          user,
          identityFile: key,
          knownHostsFile: join(dir, 'known_hosts'),
          nodeBinary: deps.nodeBinary ?? process.execPath,
          proxyScript,
          wakeUrl,
          secretFile
        })
        await writeFile(configPath, upsertSshHostBlock(current, alias, block), { mode: 0o600 })
        return {
          ok: true,
          value: {
            host: alias,
            configPath,
            command: `ssh -F ${quote(configPath)} ${alias}`,
            includeLine: `Include ${quote(configPath)}`
          }
        }
      } catch (error) {
        if (isEnvironmentProviderError(error, 'conflict')) {
          return {
            ok: false,
            code: 'unavailable',
            message: 'SSH needs a newer cloud workspace. Create a new one to use SSH.'
          }
        }
        return {
          ok: false,
          code: 'failed',
          message: error instanceof Error ? error.message : String(error)
        }
      }
    }
  )
  return () => ipcMain.removeHandler(CH.prepare)
}
