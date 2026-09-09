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
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import * as net from 'node:net'

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
// Why identityFilePath (path, not content) belongs on the wire target and
// not OutboundSshCredential: SOL-AG-EVM-003's "Sửa lại Gap 1 + Gap 4" (Gap 1)
// reverses the earlier "Vault resolves, agent receives content" decision —
// Provision always runs the recipe's create command on THIS same agent, so
// the identity file already lives on this host's disk. Reading it here
// avoids the round-trip to backend-go this task doc requires removing.
// Why knownHostKeyFingerprint lives on the target, not as a separate
// dialOutboundSshTarget parameter: TASK-AG-EVM-010/SOL-AG-EVM-003 "Sửa lại
// Gap 1 + Gap 4" (Gap 4) — this is per-target TOFU state backend-go persists
// (infra.ephemeral_vm_ssh_targets.host_key_fingerprint) and round-trips
// alongside the target's other per-dial fields (host/identityFilePath/etc),
// not a standalone credential-like value.
export type SshDialTarget = {
  host: string
  port: number
  username: string
  identityAgent?: string
  identityFilePath?: string
  knownHostKeyFingerprint?: string
  jumpHost?: string
  proxyCommand?: string
  // portForwards — CR-EVM-008/TASK-AG-EVM-011. Mirrors backend-go's
  // toWirePortForwards (devserveragent/methods.go) 1:1; label is display-
  // only and intentionally dropped there too, so it's never sent here.
  portForwards?: { localPort: number; remoteHost: string; remotePort: number }[]
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
  // TASK-AG-EVM-010: the host key fingerprint OBSERVED on this dial — always
  // set (first dial or a matching repeat dial), never empty on a resolved
  // session. backend-go persists it and sends it back as
  // target.knownHostKeyFingerprint on the next vm.sshDial for this runtimeId.
  hostKeyFingerprint: string
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

// Why credential.privateKeyPEM still wins when both are present: it is the
// backward-compat path (some other future caller — e.g. Hướng B's
// vm.readCredentialFile round-trip — may still send resolved content
// directly over RPC) and content already in hand should never trigger an
// extra disk read. identityFilePath is Hướng A's primary path (Gap 1 fix) —
// read once per dial, never cached, never written back to disk.
async function resolvePrivateKey(
  target: SshDialTarget,
  credential: OutboundSshCredential
): Promise<string | undefined> {
  if (credential.privateKeyPEM) {
    return credential.privateKeyPEM
  }
  if (target.identityFilePath) {
    return readFile(target.identityFilePath, 'utf8')
  }
  return undefined
}

// TASK-AG-EVM-010/SOL-AG-EVM-003 "Sửa lại Gap 1 + Gap 4" (Gap 4). Format
// mirrors OpenSSH/golang's ssh.FingerprintSHA256 convention ("SHA256:" +
// unpadded base64) — not required for cross-language comparison (Hướng A
// always computes AND compares on this same agent, never against
// backend-go's own Go-computed value), but keeps it human-recognizable if
// ever surfaced in a UI/log.
function computeSha256Fingerprint(hostKey: Buffer): string {
  const digestBase64 = createHash('sha256').update(hostKey).digest('base64')
  return `SHA256:${digestBase64.replace(/=+$/, '')}`
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
  sock: ClientChannel | Duplex | undefined,
  onHostKeyVerified: (fingerprint: string) => void
): ConnectConfig {
  return {
    host: sock ? undefined : target.host,
    port: sock ? undefined : target.port,
    username: target.username,
    privateKey: credential.privateKeyPEM,
    agent: target.identityAgent,
    sock,
    // TASK-AG-EVM-010/SOL-AG-EVM-003 "Sửa lại Gap 1 + Gap 4" (Gap 4) — ssh2
    // does NO host-key verification at all when hostVerifier is omitted
    // (confirmed via @types/ssh2@1.15.5's real ConnectConfig, not assumed:
    // SyncHostVerifier = (key: Buffer) => boolean, synchronous). TOFU: no
    // knownHostKeyFingerprint yet (first dial for this runtimeId, nothing
    // stored on backend-go's side) → accept and report what was observed;
    // every later dial for the same runtimeId compares against it.
    hostVerifier: (hostKey: Buffer): boolean => {
      const observed = computeSha256Fingerprint(hostKey)
      onHostKeyVerified(observed)
      if (!target.knownHostKeyFingerprint) {
        return true
      }
      return observed === target.knownHostKeyFingerprint
    }
  }
}

// setupPortForwards — CR-EVM-008/TASK-AG-EVM-011. Mirrors
// dialViaJumpHost's use of forwardOut above (same primitive: open a
// direct-tcpip channel over an already-live SSH connection), just wired to
// a local net.Server accepting connections instead of the jump-host's
// single fixed channel. Mirrors backend-go's sshconn.Connection.SetupPortForwards
// (Hướng B) — same design, different language.
//
// Awaits each server's actual listen result (not just synchronous
// net.createServer, which never throws for e.g. EADDRINUSE — that surfaces
// async via the 'error' event) so a forward that can't bind fails the
// whole dial loudly, matching Hướng B's all-or-nothing framing, instead of
// leaving a half-set-up session the caller has no way to detect failed.
async function setupPortForwards(
  client: Ssh2Client,
  forwards: SshDialTarget['portForwards']
): Promise<net.Server[]> {
  const servers: net.Server[] = []
  try {
    for (const { localPort, remoteHost, remotePort } of forwards ?? []) {
      const server = net.createServer((localSocket) => {
        client.forwardOut('127.0.0.1', localPort, remoteHost, remotePort, (err, channel) => {
          if (err) {
            localSocket.destroy(err)
            return
          }
          localSocket.pipe(channel)
          channel.pipe(localSocket)
        })
      })
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(localPort, '127.0.0.1', () => {
          server.off('error', reject)
          resolve()
        })
      })
      servers.push(server)
    }
  } catch (err) {
    for (const server of servers) {
      server.close()
    }
    throw err
  }
  return servers
}

export async function dialOutboundSshTarget(
  target: SshDialTarget,
  credential: OutboundSshCredential
): Promise<OutboundSshSession> {
  let jumpClient: Ssh2Client | undefined
  let client: Ssh2Client | undefined
  // Resolved once up front so both the jump-host hop and the real target
  // connect with the same material — and so the catch block below always
  // has the actual (possibly file-read) secret to scrub, not just whatever
  // was passed in over RPC.
  let resolvedCredential: OutboundSshCredential = credential
  // Set by buildConnectConfig's hostVerifier callback once ssh2 actually
  // calls it during the handshake — empty until then.
  let hostKeyFingerprint = ''
  let forwardServers: net.Server[] = []

  try {
    const privateKeyPEM = await resolvePrivateKey(target, credential)
    resolvedCredential = { privateKeyPEM }

    let sock: ClientChannel | Duplex | undefined
    if (target.jumpHost) {
      const hop = await dialViaJumpHost(target, resolvedCredential)
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
    const config = buildConnectConfig(target, resolvedCredential, sock, (fingerprint) => {
      hostKeyFingerprint = fingerprint
    })
    await connectSsh2Client(client, config)
    forwardServers = await setupPortForwards(client, target.portForwards)
  } catch (err) {
    for (const server of forwardServers) {
      server.close()
    }
    jumpClient?.end()
    client?.end()
    // Why NOT scrub target.identityFilePath here: the task's security note
    // scopes the "don't log" requirement to file CONTENT, not the path — a
    // readFile ENOENT/EACCES error naturally embeds the path in its message
    // (Node's own error format), and that is acceptable to surface (helps
    // diagnose a real misconfiguration); only resolvedCredential.privateKeyPEM
    // (the file's actual bytes, once read) is scrubbed.
    throw scrubCredentialFromError(err, resolvedCredential)
  }

  const readyClient = client
  return {
    client: readyClient,
    hostKeyFingerprint,
    close: (): void => {
      for (const server of forwardServers) {
        server.close()
      }
      readyClient.end()
      jumpClient?.end()
    }
  }
}
