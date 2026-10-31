import { spawn, type ChildProcess } from 'node:child_process'
import { spawnProcess } from '@orca/process-host'
import { Duplex } from 'node:stream'
import type { Socket as NetSocket } from 'node:net'
import type { SshTarget } from '../../shared/ssh-types'
import type { SshResolvedConfig } from './config/ssh-g-config-resolution'
import { quotePosixShell } from '../../shared/shell-argument-quoting'
import { isOpenSshConfigBackedTarget } from './system-transport/system-ssh-args'

// Normalize ProxyJump/jumpHost to the ProxyCommand equivalent so ssh2 has one proxy transport path.
type EffectiveProxy =
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

// cmd expands %VAR% inside quotes and can reopen quoting; reject unsafe host/user/port metacharacters rather than fake escaping.
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

// ssh2 lacks ProxyCommand; bridge the user snippet's stdin/stdout through config.sock.
function getShellSpawnConfig(command: string): ShellSpawnConfig {
  if (process.platform === 'win32') {
    const comspec = process.env.ComSpec || 'cmd.exe'
    // Match Node shell invocation with /s and verbatim args; cmd does not understand Node's backslash quote escaping.
    return {
      file: comspec,
      args: ['/d', '/s', '/c', `"${command}"`],
      windowsVerbatimArguments: true
    }
  }
  return { file: '/bin/sh', args: ['-c', command], windowsVerbatimArguments: false }
}

// Use the final hop with -W and pass preceding hops as its -J chain, matching OpenSSH.
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
      ? // Spawn structured ProxyJump argv directly so values cannot escape through a shell.
        spawnProcess({
          program: 'ssh',
          args: jumpHostSpawnArgs(proxy.jumpHost, host, port)
        })
      : (() => {
          const escape = process.platform === 'win32' ? cmdEscape : quotePosixShell
          const expanded = proxy.command
            .replace(/%h/g, escape(host))
            .replace(/%p/g, escape(String(port)))
            .replace(/%r/g, escape(user))
          const shell = getShellSpawnConfig(expanded)
          // User-authored ProxyCommand needs verbatim shell semantics; hide its Windows console to avoid focus theft (#10488).
          return spawn(shell.file, shell.args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            windowsVerbatimArguments: shell.windowsVerbatimArguments
          })
        })()

  // Keep proxy stdout/stdin separate; a bidirectional PassThrough would feed output back as input.
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
    // Honor Duplex backpressure so slow consumers cannot buffer proxy output unboundedly.
    if (!stream.push(data)) {
      proc.stdout!.pause()
    }
  }
  // Drain stderr or its full pipe blocks the proxy and looks like hung SSH.
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
