import { bunOwnedRuntimeArgs } from '../../shared/bun-owned-runtime-args'
import { prepareWslGuestTerminalHistory } from './wsl-guest-terminal-history'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { isWslShellName } from '../../shared/local-windows-terminal-runtime'
import { parseAppWslPtyId, toRelayWslPtyId } from '../../shared/wsl-pty-id'
import { addOrcaWslInteropEnv } from '../pty/wsl-orca-env'
import { isHostCodexHomeForWsl } from '../pty/codex-home-wsl-env'
import type { PtySpawnOptions } from '../providers/types'
import { createRunningWslRuntimeRunner, assertWslRuntimeDistroRunning } from './wsl-bun-runtime'
import { runWslProcess } from './wsl-runner'
import type { WslPtyOwner } from '../../shared/wsl-pty-id'

export type PreparedWslGuestSpawnOwner = Readonly<{
  owner: Readonly<WslPtyOwner>
  endpoint: Readonly<{
    distro: string
    userName?: string
    userId?: string
    runtime: string
    home?: string
    envBinary?: string
    tokenPath?: string
  }>
  home?: string
  envBinary?: string
}>

export function capturedWslGuestSpawnOwner(prepared: PreparedWslGuestSpawnOwner) {
  const daemon = prepared.endpoint.tokenPath !== undefined
  const home = prepared.endpoint.home ?? prepared.home ?? ''
  const envBinary = prepared.endpoint.envBinary ?? prepared.envBinary ?? ''
  if (
    prepared.endpoint.distro !== prepared.owner.distro ||
    !home.startsWith('/') ||
    !envBinary.startsWith('/')
  ) {
    throw new Error('Guest spawn requires captured distro, home and environment executable')
  }
  return {
    owner: Object.freeze({ ...prepared.owner }),
    endpoint: Object.freeze({ ...prepared.endpoint }),
    home,
    envBinary,
    daemon
  }
}
import { assertWslAccountExecutionTarget } from './wsl-account-execution-context'

const READ_ENVIRONMENT =
  'const owner=JSON.parse(process.argv[2]);if(String(process.getuid())!==owner.userId||process.env.HOME!==owner.home)throw new Error("WSL terminal execution owner changed");const keys=JSON.parse(process.argv[1]);console.log(JSON.stringify(Object.fromEntries(keys.filter(k=>typeof process.env[k]==="string").map(k=>[k,process.env[k]]))))'
const RUNTIME_ENV_KEYS = [
  'NODE_OPTIONS',
  'NODE_PATH',
  'BUN_OPTIONS',
  'BUN_INSPECT',
  'ELECTRON_RUN_AS_NODE'
]

function parseEnvironment(value: string): Record<string, string> {
  const parsed: unknown = JSON.parse(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid guest terminal environment')
  }
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(parsed)) {
    if (typeof entry !== 'string') {
      throw new Error('Invalid guest terminal environment value')
    }
    result[key] = entry
  }
  return result
}

/** Let WSL apply its own WSLENV/path rules before sending a guest-native spawn request. */
export async function prepareWslGuestSpawnOptions(
  captured: PreparedWslGuestSpawnOwner,
  options: PtySpawnOptions,
  signal?: AbortSignal,
  mode?: 'confirmed-exited'
): Promise<PtySpawnOptions> {
  const prepared = capturedWslGuestSpawnOwner(captured)
  const { owner } = prepared
  const execution = createRunningWslRuntimeRunner(owner.distro, signal, prepared.endpoint.userName)
  if (
    mode === 'confirmed-exited' &&
    (!prepared.daemon || !options.sessionId || options.isNewSession)
  ) {
    throw new Error('Cold restore requires an existing guest daemon terminal identity')
  }
  if (options.sessionId && !options.isNewSession) {
    toRelayWslPtyId(owner, options.sessionId)
    if (mode !== 'confirmed-exited') {
      return { ...options, isNewSession: false }
    }
  }
  if (options.attachOnly) {
    throw new Error('A WSL attach cannot create a new terminal')
  }
  if (mode !== 'confirmed-exited' && options.sessionId && parseAppWslPtyId(options.sessionId)) {
    throw new Error('A WSL terminal identity cannot be reminted as a fresh spawn')
  }
  const accountExecution = {
    distro: owner.distro,
    userName: prepared.endpoint.userName ?? '',
    userId: prepared.endpoint.userId ?? '',
    home: prepared.home
  }
  assertWslAccountExecutionTarget(accountExecution, { runtime: 'wsl', wslDistro: owner.distro })
  let cwd = options.cwd ?? prepared.home
  const unc = parseWslUncPath(cwd)
  if (unc) {
    if (unc.distro.toLowerCase() !== owner.distro.toLowerCase()) {
      throw new Error('Terminal cwd belongs to a different WSL distro')
    }
    cwd = unc.linuxPath
  } else if (!cwd.startsWith('/')) {
    cwd = await execution.run({ program: 'wslpath', args: ['-a', '-u', cwd], loginPath: 'none' })
  }
  if (!cwd.startsWith('/')) {
    throw new Error('Terminal cwd did not resolve to a guest path')
  }
  const env = { ...options.env }
  addOrcaWslInteropEnv(env)
  for (const key of ['PATH', 'Path', 'HOME', 'SHELL', ...RUNTIME_ENV_KEYS]) {
    delete env[key]
  }
  if (env.CODEX_HOME) {
    const codex = parseWslUncPath(env.CODEX_HOME)
    if (codex?.distro.toLowerCase() === owner.distro.toLowerCase()) {
      env.CODEX_HOME = codex.linuxPath
      env.ORCA_CODEX_HOME = codex.linuxPath
    } else if (codex || isHostCodexHomeForWsl(env.CODEX_HOME)) {
      delete env.CODEX_HOME
      delete env.ORCA_CODEX_HOME
    }
  }
  const keys = [
    ...new Set([
      ...Object.keys(env),
      'PATH',
      'HOME',
      'SHELL',
      'HISTFILE',
      'fish_history',
      'XDG_DATA_HOME'
    ])
  ].filter((key) => key !== 'WSLENV')
  await assertWslRuntimeDistroRunning(owner.distro, execution.signal)
  const result = await runWslProcess({
    distro: owner.distro,
    user: prepared.endpoint.userName,
    program: prepared.envBinary,
    args: [
      ...RUNTIME_ENV_KEYS.flatMap((key) => ['-u', key]),
      prepared.endpoint.runtime,
      ...bunOwnedRuntimeArgs('linux'),
      '-e',
      READ_ENVIRONMENT,
      JSON.stringify(keys),
      JSON.stringify(accountExecution)
    ],
    env,
    loginPath: 'preferred',
    timeoutMs: 15_000,
    maxOutputBytes: 256 * 1024
  })
  execution.signal.throwIfAborted()
  if (result.code !== 0 || result.timedOut || !result.environmentResolved) {
    throw new Error('WSL terminal environment could not be resolved')
  }
  const guestEnv = parseEnvironment(result.stdout)
  if (guestEnv.HOME !== prepared.home) {
    throw new Error('WSL terminal environment does not match its captured owner')
  }
  const guestShell =
    options.shellOverride && !isWslShellName(options.shellOverride)
      ? options.shellOverride
      : guestEnv.SHELL || '/bin/bash'
  if (prepared.daemon) {
    await prepareWslGuestTerminalHistory(
      execution,
      accountExecution,
      prepared.endpoint.runtime,
      prepared.envBinary,
      options,
      guestEnv,
      guestShell
    )
  }
  for (const key of options.envToDelete ?? []) {
    delete guestEnv[key]
  }
  const {
    sessionId: _freshDesktopId,
    isNewSession: _fresh,
    terminalWindowsWslDistro: _distro,
    terminalWindowsPowerShellImplementation: _powershell,
    codexHomePathOverride: _codex,
    ...guestOptions
  } = options
  return {
    ...guestOptions,
    ...(prepared.daemon ? { sessionId: _freshDesktopId, isNewSession: _fresh } : {}),
    cwd,
    env: guestEnv,
    shellOverride:
      options.shellOverride && !isWslShellName(options.shellOverride)
        ? options.shellOverride
        : prepared.daemon
          ? guestShell
          : undefined
  }
}
