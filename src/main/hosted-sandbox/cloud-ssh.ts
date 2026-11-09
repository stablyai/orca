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

/** Host alias for a workspace: unique per sandbox (same-named workspaces must not collide), ssh_config-safe. */
export function cloudSshHostAlias(workspaceName: string | undefined, sandboxId: string): string {
  const slug = (workspaceName ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  const id = sandboxId.replace(/^sbx_/, '').slice(0, 8)
  return slug ? `orca-cloud-${slug}-${id}` : `orca-cloud-${id}`
}

/**
 * One argument for ssh's ProxyCommand: ssh expands `%` tokens first (so `%` is written `%%`), then
 * hands the line to /bin/sh, so POSIX single quotes keep spaces and metacharacters literal.
 */
export function proxyArg(value: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    // Windows OpenSSH runs ProxyCommand without a shell; double quotes group each argument.
    return `"${value.replace(/%/g, '%%').replace(/"/g, '')}"`
  }
  return `'${value.replace(/%/g, '%%').replace(/'/g, `'\\''`)}'`
}

/** ssh_config value quoting (IdentityFile, UserKnownHostsFile): double quotes, `%` escaped. */
const configPath = (value: string): string =>
  `"${value.replace(/%/g, '%%').replace(/(["\\])/g, '\\$1')}"`

/** One `Host` block; the file holds one block per set-up workspace. */
export function renderSshHostBlock(args: {
  alias: string
  user?: string
  identityFile: string
  knownHostsFile: string
  /** Launcher that runs the proxy with the app's runtime (see writeProxyLauncher). */
  launcher: string
  wakeUrl: string
  secretFile: string
  configFile: string
  platform?: NodeJS.Platform
}): string {
  const user = args.user ?? DEFAULT_VM_USER
  const proxy = [args.launcher, args.wakeUrl, args.secretFile, args.configFile, args.alias, user]
    .map((value) => proxyArg(value, args.platform))
    .join(' ')
  return [
    `Host ${args.alias}`,
    `  HostName ${args.alias}`,
    `  User ${user}`,
    `  IdentityFile ${configPath(args.identityFile)}`,
    '  IdentitiesOnly yes',
    `  UserKnownHostsFile ${configPath(args.knownHostsFile)}`,
    `  ProxyCommand ${proxy}`,
    // A cloud VM is not a host the user's agent or display should be exposed to.
    '  ForwardAgent no',
    '  ForwardX11 no',
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

/** The app's own runtime at a stable path: an AppImage's mounted binary moves every launch. */
export function appRuntimePath(
  env: NodeJS.ProcessEnv = process.env,
  execPath = process.execPath
): string {
  return env.APPIMAGE ?? execPath
}

/**
 * Writes the launcher the ProxyCommand calls (in userData, so the ssh config never names the app's
 * install path). Rewritten on every app start, so a moved or updated app keeps working.
 */
export async function writeProxyLauncher(
  dir: string,
  platform: NodeJS.Platform = process.platform,
  runtime = appRuntimePath()
): Promise<string> {
  const script = join(dir, 'orca-cloud-ssh-proxy.cjs')
  await writeFile(script, CLOUD_SSH_PROXY_SCRIPT, { mode: 0o600 })
  if (platform === 'win32') {
    // Windows OpenSSH runs ProxyCommand without a shell: a .cmd sets the variable itself.
    const launcher = join(dir, 'orca-cloud-ssh-proxy.cmd')
    await writeFile(
      launcher,
      `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${runtime}" "${script}" %*\r\n`
    )
    return launcher
  }
  const launcher = join(dir, 'orca-cloud-ssh-proxy')
  const sq = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`
  await writeFile(
    launcher,
    `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${sq(runtime)} ${sq(script)} "$@"\n`,
    {
      mode: 0o700
    }
  )
  await chmod(launcher, 0o700)
  return launcher
}

export function installCloudSshHandlers(deps: {
  userDataPath: string
  client: HostedSandboxControlPlaneClient
}): () => void {
  const dir = join(deps.userDataPath, 'cloud-ssh')
  // Refresh the launcher for configs written by an earlier (or moved) install.
  void stat(dir)
    .then(() => writeProxyLauncher(dir))
    .catch(() => undefined)
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
        const launcher = await writeProxyLauncher(dir)
        const alias = cloudSshHostAlias(found.runtime.workspaceName, found.sandboxId)
        const configFile = join(dir, 'config')
        const current = await readFile(configFile, 'utf8').catch(() => '')
        const block = renderSshHostBlock({
          alias,
          user,
          identityFile: key,
          knownHostsFile: join(dir, 'known_hosts'),
          launcher,
          wakeUrl,
          secretFile,
          configFile
        })
        await writeFile(configFile, upsertSshHostBlock(current, alias, block), { mode: 0o600 })
        return {
          ok: true,
          value: {
            host: alias,
            configPath: configFile,
            command: `ssh -F ${configPath(configFile)} ${alias}`,
            includeLine: `Include ${configPath(configFile)}`
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
