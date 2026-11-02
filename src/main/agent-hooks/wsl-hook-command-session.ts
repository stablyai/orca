import { spawnProcess } from '@orca/process-host'
import { resolve, posix } from 'node:path'
import { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { waitForWslRelaySentinel } from './wsl-hook-relay-sentinel'
import { buildGuestNodeSelectionScript, resolveWslHookRelayBundle } from './wsl-hook-relay-launch'
import { resolveWslExecutablePath } from '../wsl/wsl-executable-path'
import { resolveWslInteropSpawnCwd } from '../wsl-interop-spawn-directory'
import { buildWslExecArgs } from '../../shared/wsl-login-shell-command'
import { quotePosixShell } from '../../shared/shell-argument-quoting'
import {
  readWslCliContext,
  WSL_CLI_CONTEXT_ENV,
  WSL_CLI_ROOT_ENV_KEYS,
  type WslCliContext
} from '../../shared/wsl-cli-context'
import { WSL_HOOK_FS_METHODS } from '../../shared/wsl-hook-relay-contract'

export function buildWslHookCommandScript(
  context: WslCliContext,
  raw: string,
  bundle: string
): string {
  return [
    'set -eu',
    'unset NODE_OPTIONS NODE_REPL_EXTERNAL_MODULE',
    'unset ORCA_AGENT_HOOK_PORT ORCA_AGENT_HOOK_TOKEN ORCA_AGENT_HOOK_ENDPOINT',
    ...WSL_CLI_ROOT_ENV_KEYS.map((key) =>
      context.env[key] === undefined
        ? `unset ${key}`
        : `export ${key}=${quotePosixShell(context.env[key])}`
    ),
    `export HOME=${quotePosixShell(context.home)}`,
    `export ${WSL_CLI_CONTEXT_ENV}=${quotePosixShell(raw)}`,
    `cd -- ${quotePosixShell(context.cwd)}`,
    buildGuestNodeSelectionScript(),
    `entry=$(wslpath -u ${quotePosixShell(bundle)})`,
    'exec "$n" "$entry" --hook-filesystem'
  ].join('\n')
}

/** One child, one mux, no relay manager; EOF fences mutations and joins the guest's admitted work. */
export async function openWslHookCommandSession(
  distro: string,
  raw: string
): Promise<{
  mux: SshChannelMultiplexer
  home: string
  configDir: string
  close: () => Promise<void>
}> {
  const context = readWslCliContext(raw)
  // Emitted beside out/main: plain-Node CLI hosts need no desktop AppEnvironment.
  const bundle = resolveWslHookRelayBundle(resolve(__dirname, '../../..'))
  if (!bundle) {
    throw new Error('The bundled WSL hooks helper is missing. Reinstall Orca.')
  }
  const child = spawnProcess({
    program: resolveWslExecutablePath(),
    args: buildWslExecArgs(
      distro,
      ['sh', '-c', buildWslHookCommandScript(context, raw, bundle.jsPath)],
      { user: context.user }
    ),
    cwd: resolveWslInteropSpawnCwd(),
    env: { ...process.env, WSL_UTF8: '1' },
    stdio: 'pipe'
  })
  let launchError: Error | undefined
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-4096)
  })
  const closed = new Promise<void>((resolve, reject) => {
    child.once('error', (error) => {
      launchError = error
    })
    child.once('close', (code, signal) =>
      code === 0 && !launchError
        ? resolve()
        : reject(
            launchError ??
              new Error(
                `WSL hooks session exited (${signal ?? code ?? 'unknown'}): ${stderr.trim()}`
              )
          )
    )
  })
  void closed.catch(() => {})
  let mux: SshChannelMultiplexer | undefined
  let canceled = false
  const cancel = (): void => {
    canceled = true
    mux?.dispose()
    child.stdin.end()
  }
  process.once('SIGINT', cancel)
  process.once('SIGTERM', cancel)
  const close = async (): Promise<void> => {
    child.stdin.end()
    try {
      await closed
      if (canceled) {
        throw new Error('WSL hooks command was canceled')
      }
    } finally {
      process.off('SIGINT', cancel)
      process.off('SIGTERM', cancel)
      mux?.dispose()
    }
  }
  try {
    const transport = await waitForWslRelaySentinel(child)
    // Disposal must close stdin, never kill a guest with an admitted physical publication.
    mux = new SshChannelMultiplexer({ ...transport, close: () => child.stdin.end() })
    const home = await mux.request(WSL_HOOK_FS_METHODS.home)
    if (
      !home ||
      typeof home !== 'object' ||
      !('ok' in home) ||
      home.ok !== true ||
      !('home' in home) ||
      home.home !== posix.resolve(context.home) ||
      !('claudeConfigDir' in home) ||
      typeof home.claudeConfigDir !== 'string' ||
      !home.claudeConfigDir.startsWith('/') ||
      !('physicalAtomicWrite' in home) ||
      home.physicalAtomicWrite !== true
    ) {
      throw new Error('WSL hooks session did not establish its invocation target')
    }
    return { mux, home: home.home, configDir: home.claudeConfigDir, close }
  } catch (error) {
    await close().catch(() => {})
    throw error
  }
}
