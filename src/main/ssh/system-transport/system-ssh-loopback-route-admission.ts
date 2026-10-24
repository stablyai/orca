/**
 * Whether a proxied target may switch to the loopback route. Fails closed: the route is only a
 * speedup, so any doubt keeps the direct proxy route.
 */
import { dirname, join } from 'node:path'
import { runProcess } from '@orca/process-host'
import type { SshTarget } from '../../../shared/ssh-types'
import { parseSshGOutput } from '../config/ssh-g-config-resolution'
import { requiresSystemSshForSecurityKey } from '../ssh-transport-selection'
import { buildSshArgs, type SystemSshBuildArgsOptions } from './system-ssh-args'
import { findSystemSsh } from './system-ssh-binary'

const LOOPBACK_ROUTE_ADMISSION_TIMEOUT_MS = 5_000

// Why: these are exactly what the route rewrites; any other difference means ssh_config matched
// differently once HostName became 127.0.0.1 (e.g. `Match host`), so commands would change identity.
// ControlPath only matters for multiplexing, which Windows OpenSSH cannot do, and `%C` differs by host.
const ROUTE_REWRITTEN_SSH_G_KEYS = new Set([
  'hostname',
  'port',
  'hostkeyalias',
  'proxycommand',
  'proxyjump',
  'controlpath'
])
const IDENTITY_SSH_G_KEYS = ['identityfile', 'certificatefile']
// Why bounded: a hop's own ProxyJump is followed, and ssh_config can loop.
const MAX_JUMP_HOPS = 8

/** On admission, where the forward must land and the known_hosts name OpenSSH uses for it. */
export type LoopbackRouteAdmission =
  | { admitted: true; sshdPort: number; hostKeyAlias: string }
  | { admitted: false; reason: string }

export async function admitSystemSshLoopbackRoute(
  target: SshTarget,
  options: SystemSshBuildArgsOptions
): Promise<LoopbackRouteAdmission> {
  const sshPath = findSystemSsh()
  if (!sshPath) {
    return refuse('no system ssh binary')
  }
  const direct = await readEffectiveSshConfig(
    sshPath,
    buildSshArgs(target, { ...options, loopbackRoute: undefined })
  )
  const endpoint = direct ? readDialledEndpoint(direct) : null
  if (!direct || !endpoint) {
    return refuse('ssh -G failed')
  }
  // Why port 1: the real local port is not bound yet, and the port is a rewritten key anyway.
  const routed = await readEffectiveSshConfig(
    sshPath,
    buildSshArgs(target, {
      ...options,
      loopbackRoute: { localPort: 1, hostKeyAlias: endpoint.hostKeyAlias }
    })
  )
  if (!routed || !isRewrittenToLoopback(routed)) {
    return refuse('route options did not take effect')
  }
  const drifted = findConfigDrift(direct, routed)
  if (drifted.length > 0) {
    return refuse(`route changes ${drifted.join(', ')}`)
  }
  // Why: every security-key login asks for a touch, so the forward and probe would add unprompted ones.
  if (await mayAskForSecurityKey(sshPath, direct)) {
    return refuse('may use a security key')
  }
  const hopRefusal = await checkJumpHops(sshPath, direct, options)
  return hopRefusal ? refuse(hopRefusal) : { admitted: true, ...endpoint }
}

function refuse(reason: string): LoopbackRouteAdmission {
  return { admitted: false, reason }
}

/** The sshd the direct route reaches, as OpenSSH resolved it — the forward must land on the same one. */
export function readDialledEndpoint(
  direct: Map<string, string[]>
): { sshdPort: number; hostKeyAlias: string } | null {
  const hostname = direct.get('hostname')?.[0]
  const sshdPort = Number(direct.get('port')?.[0] ?? '22')
  if (!hostname || !Number.isInteger(sshdPort) || sshdPort <= 0) {
    return null
  }
  const alias = direct.get('hostkeyalias')?.[0]
  const hostKeyAlias =
    alias && alias.toLowerCase() !== 'none'
      ? alias
      : sshdPort === 22
        ? hostname
        : `[${hostname}]:${sshdPort}`
  return { sshdPort, hostKeyAlias }
}

function isRewrittenToLoopback(routed: Map<string, string[]>): boolean {
  const proxyCommand = routed.get('proxycommand')?.[0]?.toLowerCase()
  const proxyJump = routed.get('proxyjump')?.[0]?.toLowerCase()
  return (
    routed.get('hostname')?.[0] === '127.0.0.1' &&
    (proxyCommand === undefined || proxyCommand === 'none') &&
    (proxyJump === undefined || proxyJump === 'none')
  )
}

/** Identity files (with `%` tokens unresolvable here) or agent keys that could need a touch. */
async function mayAskForSecurityKey(
  sshPath: string,
  config: Map<string, string[]>
): Promise<boolean> {
  const identityValues = IDENTITY_SSH_G_KEYS.flatMap((key) => config.get(key) ?? [])
  if (identityValues.some(hasUnexpandedToken)) {
    return true
  }
  const resolved = parseSshGOutput(serializeSshGLines(config))
  // Why config-backed: then the check reads exactly the IdentityFile list `ssh -G` reported.
  const configBacked: SshTarget = {
    id: 'loopback-admission',
    label: 'loopback-admission',
    host: 'loopback-admission',
    configHost: 'loopback-admission',
    port: 22,
    username: '',
    source: 'ssh-config'
  }
  return (
    (await requiresSystemSshForSecurityKey(configBacked, resolved)) ||
    (await agentMayHoldSecurityKey(sshPath, config))
  )
}

/** The forward also logs in to every ProxyJump hop, whose ssh does not inherit BatchMode. */
async function checkJumpHops(
  sshPath: string,
  direct: Map<string, string[]>,
  options: SystemSshBuildArgsOptions
): Promise<string | null> {
  const pending = listJumpHosts(direct)
  const seen = new Set<string>()
  for (let jump = pending.shift(); jump !== undefined; jump = pending.shift()) {
    if (seen.has(jump)) {
      continue
    }
    seen.add(jump)
    if (seen.size > MAX_JUMP_HOPS) {
      return 'jump chain too long to check'
    }
    const hop = await readEffectiveSshConfig(sshPath, buildJumpHostSshGArgs(jump, options))
    if (!hop) {
      return `ssh -G failed for jump host ${jump}`
    }
    if (await mayAskForSecurityKey(sshPath, hop)) {
      return `jump host ${jump} may use a security key`
    }
    pending.push(...listJumpHosts(hop))
  }
  return null
}

/** The ProxyJump chain a route takes, as OpenSSH resolved it (including a manual `-J`). */
export function listJumpHosts(config: Map<string, string[]>): string[] {
  const configured = config.get('proxyjump')?.[0]
  if (!configured || configured.toLowerCase() === 'none') {
    return []
  }
  return configured
    .split(',')
    .map((jump) => jump.trim())
    .filter(Boolean)
}

/** `[user@]host[:port]` or `ssh://[user@]host[:port]` as `ssh -G` destination args. */
export function buildJumpHostSshGArgs(jump: string, options: SystemSshBuildArgsOptions): string[] {
  const spec = jump.replace(/^ssh:\/\//i, '')
  const at = spec.lastIndexOf('@')
  const user = at === -1 ? '' : spec.slice(0, at)
  const hostPort = spec.slice(at + 1)
  const match = /^\[(.+)\](?::(\d+))?$/.exec(hostPort) ?? /^([^:]+)(?::(\d+))?$/.exec(hostPort)
  const host = match?.[1] ?? hostPort
  const port = match?.[2]
  return [
    ...(options.configFile ? ['-F', options.configFile] : []),
    ...(port ? ['-p', port] : []),
    '--',
    user ? `${user}@${host}` : host
  ]
}

function serializeSshGLines(config: Map<string, string[]>): string {
  return [...config].flatMap(([key, values]) => values.map((value) => `${key} ${value}`)).join('\n')
}

/** Each `ssh -G` line keyed by option; repeated options (IdentityFile, SendEnv…) keep every value. */
function parseSshGLines(stdout: string): Map<string, string[]> {
  const options = new Map<string, string[]>()
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    const space = line.indexOf(' ')
    if (space === -1) {
      continue
    }
    const key = line.slice(0, space).toLowerCase()
    options.set(key, [...(options.get(key) ?? []), line.slice(space + 1).trim()])
  }
  return options
}

/**
 * Settings the route would change. A `%` token counts even when both outputs match: `ssh -G`
 * leaves some unexpanded, and a routed login expands `%h` to 127.0.0.1.
 */
export function findConfigDrift(
  direct: Map<string, string[]>,
  routed: Map<string, string[]>
): string[] {
  const keys = new Set([...direct.keys(), ...routed.keys()])
  return [...keys]
    .filter((key) => !ROUTE_REWRITTEN_SSH_G_KEYS.has(key))
    .filter((key) => {
      const directValue = (direct.get(key) ?? []).join('\n')
      const routedValue = (routed.get(key) ?? []).join('\n')
      return directValue !== routedValue || hasUnexpandedToken(directValue)
    })
    .sort()
}

/** `%h`-style tokens and `${VAR}` references that `ssh -G` may print unexpanded. */
function hasUnexpandedToken(value: string): boolean {
  return value.replaceAll('%%', '').includes('%') || value.includes('${')
}

/**
 * `ssh-add -L` lists sk- key types. An unreachable default agent can sign nothing; an unreachable
 * configured IdentityAgent may only be a path ssh-add resolved differently, so it fails closed.
 */
export function agentListingMayHoldSecurityKey(
  result: { code: number | null; stdout: string; timedOut: boolean },
  agentConfigured: boolean
): boolean {
  if (result.timedOut) {
    return true
  }
  if (result.code === 0) {
    return result.stdout.split(/\r?\n/).some((line) => line.trim().startsWith('sk-'))
  }
  // Why: exit 1 is "The agent has no identities"; exit 2 is "could not connect to the agent".
  return !(result.code === 1 || (result.code === 2 && !agentConfigured))
}

async function agentMayHoldSecurityKey(
  sshPath: string,
  direct: Map<string, string[]>
): Promise<boolean> {
  const identityAgent = direct.get('identityagent')?.[0]
  if (identityAgent?.toLowerCase() === 'none') {
    return false
  }
  const sshAddPath = join(
    dirname(sshPath),
    process.platform === 'win32' ? 'ssh-add.exe' : 'ssh-add'
  )
  const agentConfigured = Boolean(identityAgent && identityAgent !== 'SSH_AUTH_SOCK')
  const env = agentConfigured ? { ...process.env, SSH_AUTH_SOCK: identityAgent } : process.env
  try {
    return agentListingMayHoldSecurityKey(
      await runProcess({
        program: sshAddPath,
        args: ['-L'],
        env,
        timeoutMs: LOOPBACK_ROUTE_ADMISSION_TIMEOUT_MS
      }),
      agentConfigured
    )
  } catch {
    return true
  }
}

async function readEffectiveSshConfig(
  sshPath: string,
  args: string[]
): Promise<Map<string, string[]> | null> {
  try {
    const result = await runProcess({
      program: sshPath,
      args: ['-G', ...args],
      timeoutMs: LOOPBACK_ROUTE_ADMISSION_TIMEOUT_MS
    })
    return result.code === 0 && !result.timedOut ? parseSshGLines(result.stdout) : null
  } catch {
    return null
  }
}
