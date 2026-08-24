import { spawn, type ChildProcess } from 'node:child_process'
import { spawnProcess } from '../../shared/child-process/run-process'
import { Duplex } from 'node:stream'
import type { Socket as NetSocket } from 'node:net'
import type { SshTarget } from '../../shared/ssh-types'
import type { SshResolvedConfig } from './ssh-config-parser'
import { shellEscape } from './ssh-connection-utils'
import { isOpenSshConfigBackedTarget } from './system-ssh-args'

// Why: ProxyJump and jumpHost are syntactic sugar for ProxyCommand.
// OpenSSH internally converts `ProxyJump bastion` to
// `ProxyCommand ssh -W %h:%p bastion`. We do the same so that ssh2
// gets a single proxy spawn path regardless of how the tunnel was configured.
export type EffectiveProxy =
  | { kind: 'proxy-command'; command: string }
  | { kind: 'jump-host'; jumpHost: string }

export function resolveEffectiveProxy(
  target: SshTarget,
  resolved: SshResolvedConfig | null
): EffectiveProxy | undefined {
  if (isOpenSshConfigBackedTarget(target) && resolved) {
    if (resolved.proxyCommand) {
      return { kind: 'proxy-command', command: resolved.proxyCommand }
    }
    return resolved.proxyJump ? { kind: 'jump-host', jumpHost: resolved.proxyJump } : undefined
  }
  if (target.proxyCommand) {
    return { kind: 'proxy-command', command: target.proxyCommand }
  }
  if (resolved?.proxyCommand) {
    return { kind: 'proxy-command', command: resolved.proxyCommand }
  }
  const jump = target.jumpHost || resolved?.proxyJump
  if (jump) {
    return { kind: 'jump-host', jumpHost: jump }
  }
  return undefined
}

// Why: cmd.exe has no quoting that survives arbitrary values — `%VAR%` expands
// inside quotes and `""` re-opens the unquoted state — so the only safe Windows
// expansion is to reject metacharacters instead of pretending to escape them.
// Hosts, ports and usernames never legitimately contain these.
const CMD_UNSAFE_PATTERN = /["%&|<>^\r\n]/

function cmdEscape(s: string): string {
  if (CMD_UNSAFE_PATTERN.test(s)) {
    throw new Error(
      `ProxyCommand value cannot be safely expanded on Windows (unsupported characters): ${s}`
    )
  }
  return `"${s}"`
}

type ShellSpawnConfig = { file: string; args: string[]; windowsVerbatimArguments: boolean }

// Why: ssh2 doesn't natively support ProxyCommand. When the SSH config
// specifies one (e.g. `cloudflared access ssh --hostname %h`), we spawn
// the command and bridge its stdin/stdout into a Duplex stream that ssh2
// uses as its transport socket via `config.sock`.
function getShellSpawnConfig(command: string): ShellSpawnConfig {
  if (process.platform === 'win32') {
    const comspec = process.env.ComSpec || 'cmd.exe'
    // Why: mirror Node's own `shell: true` form. `/s` makes cmd.exe strip the
    // outer quotes and take the rest verbatim; without verbatim arguments Node
    // would backslash-escape inner quotes, which cmd.exe does not understand.
    return {
      file: comspec,
      args: ['/d', '/s', '/c', `"${command}"`],
      windowsVerbatimArguments: true
    }
  }
  return { file: '/bin/sh', args: ['-c', command], windowsVerbatimArguments: false }
}

// Why: ProxyJump takes a comma-separated chain, but `ssh -W host:port dest`
// only tunnels through a single final hop. Preceding hops become that hop's own
// -J chain, which is how OpenSSH expands a multi-hop ProxyJump.
function jumpHostSpawnArgs(jumpHost: string, host: string, port: number): string[] {
  const hops = jumpHost
    .split(',')
    .map((hop) => hop.trim())
    .filter(Boolean)
  const destination = hops.at(-1) ?? jumpHost
  const chain = hops.slice(0, -1)
  return [
    '-W',
    `${host}:${port}`,
    ...(chain.length > 0 ? ['-J', chain.join(',')] : []),
    '--',
    destination
  ]
}

export function spawnProxyCommand(
  proxy: EffectiveProxy,
  host: string,
  port: number,
  user: string
): { process: ChildProcess; sock: NetSocket } {
  const proc =
    proxy.kind === 'jump-host'
      ? // Why: ProxyJump is structured input, not a shell snippet. Spawn ssh
        // directly so jump-host values cannot escape through shell parsing.
        spawnProcess({
          program: 'ssh',
          args: jumpHostSpawnArgs(proxy.jumpHost, host, port)
        })
      : (() => {
          const escape = process.platform === 'win32' ? cmdEscape : shellEscape
          const expanded = proxy.command
            .replace(/%h/g, escape(host))
            .replace(/%p/g, escape(String(port)))
            .replace(/%r/g, escape(user))
          const shell = getShellSpawnConfig(expanded)
          // Why not spawnProcess here: a ProxyCommand is a user-authored shell
          // snippet, so it keeps its own verbatim command line. The console
          // still has to be hidden -- a cmd.exe spawn from a GUI process always
          // flashes and steals foreground otherwise (#10488).
          return spawn(shell.file, shell.args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            windowsVerbatimArguments: shell.windowsVerbatimArguments
          })
        })()

  // Why: a single PassThrough for both directions creates a feedback loop.
  // Reads come from the proxy's stdout; writes go to its stdin.
  let cleanedUp = false
  const cleanup = (): void => {
    if (cleanedUp) {
      return
    }
    cleanedUp = true
    proc.stdout!.off('data', onStdoutData)
    proc.stdout!.off('end', onStdoutEnd)
    proc.stderr!.off('data', onStderrData)
    proc.stdin!.off('error', onInputError)
    proc.off('error', onProcessError)
  }
  const onStdoutData = (data: Buffer): void => {
    // Why: honour the Duplex's backpressure so a slow ssh2 consumer cannot
    // buffer the proxy's output unboundedly.
    if (!stream.push(data)) {
      proc.stdout!.pause()
    }
  }
  // Why: an undrained stderr pipe fills and blocks the proxy process, which
  // looks like a silently hung connection.
  const onStderrData = (data: Buffer): void => {
    const text = data.toString('utf-8').trimEnd()
    if (text) {
      console.error(`[ssh-proxy-command] ${text}`)
    }
  }
  const onStdoutEnd = (): void => {
    stream.push(null)
  }
  const onInputError = (err: Error): void => {
    stream.destroy(err)
  }
  const onProcessError = (err: Error): void => {
    stream.destroy(err)
  }
  const stream = new Duplex({
    read() {
      proc.stdout!.resume()
    },
    write(chunk, _encoding, cb) {
      proc.stdin!.write(chunk, cb)
    },
    destroy(err, cb) {
      cleanup()
      cb(err)
    }
  })
  proc.stdout!.on('data', onStdoutData)
  proc.stdout!.on('end', onStdoutEnd)
  proc.stderr!.on('data', onStderrData)
  proc.stdin!.on('error', onInputError)
  proc.on('error', onProcessError)

  return { process: proc, sock: stream as unknown as NetSocket }
}
