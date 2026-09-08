// src/relay/ssh-outbound-client.ts
// TASK-AG-EVM-005/SOL-AG-EVM-003 "Quyết định đã chốt" mục 2: agent dials OUT
// to a user's SSH target (Hướng A, agent-outbound SSH mode). `ssh2`'s
// ConnectConfig has no `jumpHost`/`proxyCommand` field (confirmed by reading
// @types/ssh2@1.15.5's index.d.ts, matching the ssh2@1.17.0 runtime — see
// node_modules/.pnpm/@types+ssh2@1.15.5) — both are OpenSSH ssh_config
// constructs (ProxyJump/ProxyCommand), not ssh2 primitives. The only two
// primitives ssh2 gives us are ConnectConfig.sock (a Readable to use instead
// of opening a new TCP socket — "useful for connection hopping") and
// Client.prototype.forwardOut() (opens a direct-tcpip channel over an
// existing connection, returning a Duplex usable as `sock`). This module is
// the thin adapter layer SOL-AG-EVM-003 concluded is required on top of
// those two primitives — not a gap in ssh2 itself.
import { Client as Ssh2Client } from 'ssh2'
import type { ClientChannel, ConnectConfig } from 'ssh2'
import { spawn } from 'node:child_process'
import { Duplex } from 'node:stream'

// Why a narrower type than the full EphemeralVmRecipeSshTargetSchema (which
// requires `label` and carries display-only fields like `configHost`/
// `identitiesOnly`/`relayGracePeriodSeconds`): dialOutboundSshTarget only
// ever reads host/port/username/jumpHost/proxyCommand/identityAgent (see
// dialViaJumpHost/buildConnectConfig below) — never `label`. Backend-go's
// real vm.sshDial wire contract (TASK-BE-EVM-014's DialHiddenSshTarget)
// sends exactly this flat shape, with no `label` — requiring the full
// recipe schema here rejected every real dial from backend-go (found
// during CR-EVM-005 cross-side reconciliation, 2026-09-08). A full
// EphemeralVmRecipeSshTarget still satisfies this structurally, so no
// existing caller/fixture breaks.
export type SshDialTarget = {
  host: string
  port: number
  username: string
  identityAgent?: string
  jumpHost?: string
  proxyCommand?: string
}

// Why: credential material (SOL-AG-EVM-003 quyết định 1 — RPC param, agent
// never fetches Vault itself) must live only for the lifetime of the dial
// call/session, never written to disk. `identityAgent` is NOT secret material
// — it's a local UNIX socket path ssh2 dereferences itself via ConnectConfig's
// `agent` field, so it stays on `target`, not here.
export type OutboundSshCredential = {
  privateKeyPEM?: string
}

export type OutboundSshSession = {
  client: Ssh2Client
  close(): void
}

// Why: ssh2/Node error objects can embed arbitrary context in `.message` —
// defense in depth so a future ssh2 upgrade that starts echoing connect
// options back in an error can never leak `privateKeyPEM` through a thrown
// Error's message (the security regression-guard this task requires).
function scrubCredentialFromError(err: unknown, credential: OutboundSshCredential): Error {
  const original = err instanceof Error ? err : new Error(String(err))
  if (!credential.privateKeyPEM) {
    return original
  }
  if (!original.message.includes(credential.privateKeyPEM)) {
    return original
  }
  const scrubbed = new Error(original.message.split(credential.privateKeyPEM).join('[REDACTED]'))
  scrubbed.stack = original.stack?.split(credential.privateKeyPEM).join('[REDACTED]')
  return scrubbed
}

function connectSsh2Client(client: Ssh2Client, config: ConnectConfig): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onReady = (): void => {
      client.removeListener('error', onError)
      resolve()
    }
    const onError = (err: Error): void => {
      client.removeListener('ready', onReady)
      reject(err)
    }
    client.once('ready', onReady).once('error', onError).connect(config)
  })
}

// Dial a secondary Ssh2Client to `target.jumpHost` first, then open a
// direct-tcpip channel through it to the real target (`host`/`port`) —
// the standard ssh2 "double hop" idiom SOL-AG-EVM-003 mục 2 confirms is not
// a hack. `jumpHost` is a bare hostname (no embedded user@host:port, per
// ssh-target-save-payload.test.ts's fixtures) with no credential of its own
// — dial it with the same username/credential as the real target.
async function dialViaJumpHost(
  target: SshDialTarget,
  credential: OutboundSshCredential
): Promise<{ sock: ClientChannel; jumpClient: Ssh2Client }> {
  const jumpClient = new Ssh2Client()
  try {
    await connectSsh2Client(jumpClient, {
      host: target.jumpHost,
      port: 22,
      username: target.username,
      privateKey: credential.privateKeyPEM,
      agent: target.identityAgent
    })
  } catch (err) {
    jumpClient.end()
    throw err
  }

  const sock = await new Promise<ClientChannel>((resolve, reject) => {
    jumpClient.forwardOut('127.0.0.1', 0, target.host, target.port, (err, channel) => {
      if (err) {
        reject(err)
        return
      }
      resolve(channel)
    })
  }).catch((err: unknown) => {
    jumpClient.end()
    throw err
  })

  return { sock, jumpClient }
}

// OpenSSH ProxyCommand convention: `%h`/`%p` are host/port tokens the command
// line expects substituted before it runs (fixture:
// 'cloudflared access ssh --hostname %h' — ssh-target-save-payload.test.ts).
function expandProxyCommandTokens(proxyCommand: string, host: string, port: number): string {
  return proxyCommand.replace(/%h/g, host).replace(/%p/g, String(port))
}

// ssh2 does not spawn ProxyCommand itself — this wraps a child process's
// stdin/stdout into a single Duplex usable as ConnectConfig.sock. Cross-
// platform per AGENTS.md: `spawn(command, { shell: true })` lets Node pick
// the host's default shell (cmd.exe via ComSpec on Windows, $SHELL/sh on
// POSIX) instead of hardcoding a shell path.
function spawnProxyCommandDuplex(proxyCommand: string, host: string, port: number): Duplex {
  const resolvedCommand = expandProxyCommandTokens(proxyCommand, host, port)
  const child = spawn(resolvedCommand, { shell: true, stdio: ['pipe', 'pipe', 'pipe'] })

  const duplex = new Duplex({
    read(): void {
      child.stdout?.resume()
    },
    write(chunk, encoding, callback): void {
      child.stdin?.write(chunk, encoding, callback)
    },
    final(callback): void {
      child.stdin?.end()
      callback()
    },
    destroy(err, callback): void {
      child.kill()
      callback(err)
    }
  })

  child.stdout?.on('data', (chunk: Buffer) => {
    if (!duplex.push(chunk)) {
      child.stdout?.pause()
    }
  })
  child.stdout?.on('end', () => duplex.push(null))
  child.on('error', (err) => duplex.destroy(err))
  // Why: an unconsumed stderr stream can itself back-pressure/hang the child
  // on some platforms — drain it without surfacing it on the Duplex (stderr
  // is proxy-transport diagnostics, not part of the SSH byte stream).
  child.stderr?.resume()

  return duplex
}

function buildConnectConfig(
  target: SshDialTarget,
  credential: OutboundSshCredential,
  sock: ClientChannel | Duplex | undefined
): ConnectConfig {
  return {
    host: sock ? undefined : target.host,
    port: sock ? undefined : target.port,
    username: target.username,
    privateKey: credential.privateKeyPEM,
    agent: target.identityAgent,
    sock
  }
}

export async function dialOutboundSshTarget(
  target: SshDialTarget,
  credential: OutboundSshCredential
): Promise<OutboundSshSession> {
  let jumpClient: Ssh2Client | undefined
  let client: Ssh2Client | undefined

  try {
    let sock: ClientChannel | Duplex | undefined
    if (target.jumpHost) {
      const hop = await dialViaJumpHost(target, credential)
      sock = hop.sock
      jumpClient = hop.jumpClient
    } else if (target.proxyCommand) {
      sock = spawnProxyCommandDuplex(target.proxyCommand, target.host, target.port)
    }

    // Why constructed here (not up front): construction order should follow
    // actual connection order — the jump client (if any) dials first, and
    // the real target client is only created once its transport (`sock`) is
    // ready. Constructing it earlier would leave an unconnected client
    // dangling if the jump hop itself fails.
    client = new Ssh2Client()
    await connectSsh2Client(client, buildConnectConfig(target, credential, sock))
  } catch (err) {
    jumpClient?.end()
    client?.end()
    throw scrubCredentialFromError(err, credential)
  }

  const readyClient = client
  return {
    client: readyClient,
    close: (): void => {
      readyClient.end()
      jumpClient?.end()
    }
  }
}
