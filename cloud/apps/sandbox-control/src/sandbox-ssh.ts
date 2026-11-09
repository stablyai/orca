// Wake on SSH. Vercel exposes only HTTP(S)/WSS routes, so a real sshd in the VM (loopback only,
// key-only) is reached through a tiny WebSocket↔TCP bridge on SSH_BRIDGE_PORT. The desktop's
// ProxyCommand calls the ssh-wake route first (single-flight wake + start sshd/bridge), then pipes
// ssh over wss. SSH's own encryption is end to end; the bridge only ever sees ciphertext.
import { z } from 'zod'
import { markProviderStopped, type LifecycleDeps } from './lifecycle'
import { ProviderError, type SandboxProviderApi } from './sandbox-provider'
import { getSandbox, type SandboxRow } from './store'
import { wakeSandbox, type WakeAnswer, type WorkspaceConfig } from './workspace-lifecycle'

import { SSH_BRIDGE_PORT } from './sandbox-vm-commands'
export { SSH_BRIDGE_PORT }
const SSHD_PORT = 2200

/**
 * Minimal RFC 6455 server (binary frames, client masking, ping/pong, close) that forwards one TCP
 * connection per upgrade to sshd on loopback. Rejects any upgrade without the bridge token.
 */
const BRIDGE_JS = String.raw`
const http = require('http'), net = require('net'), crypto = require('crypto'), fs = require('fs')
const port = Number(process.argv[2]), target = Number(process.argv[3]), tokenFile = process.argv[4]
const token = fs.readFileSync(tokenFile, 'utf8').trim()
const eq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y) }
function frame(op, data) {
  const len = data.length
  const head = len < 126 ? Buffer.from([0x80 | op, len]) : len < 65536 ? Buffer.from([0x80 | op, 126, len >> 8, len & 255]) : Buffer.concat([Buffer.from([0x80 | op, 127, 0, 0, 0, 0]), (() => { const b = Buffer.alloc(4); b.writeUInt32BE(len); return b })()])
  return Buffer.concat([head, data])
}
const server = http.createServer((req, res) => { res.writeHead(req.url === '/healthz' ? 200 : 404); res.end() })
server.on('upgrade', (req, sock, head) => {
  const t = new URL(req.url, 'http://x').searchParams.get('t') || ''
  const key = req.headers['sec-websocket-key']
  if (!key || !eq(t, token)) { sock.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n')
  sock.setNoDelay(true)
  const tcp = net.connect(target, '127.0.0.1'); tcp.setNoDelay(true)
  let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0), closed = false
  const close = () => { if (closed) return; closed = true; try { sock.end(frame(8, Buffer.alloc(0))) } catch {} tcp.destroy() }
  tcp.on('data', (d) => sock.write(frame(2, d)))
  tcp.on('close', close); tcp.on('error', close); sock.on('close', close); sock.on('error', close)
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d])
    for (;;) {
      if (buf.length < 2) return
      const op = buf[0] & 15, masked = (buf[1] & 128) !== 0
      let len = buf[1] & 127, off = 2
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4 }
      else if (len === 127) { if (buf.length < 10) return; len = buf.readUInt32BE(6); off = 10 }
      const need = off + (masked ? 4 : 0) + len
      if (buf.length < need) return
      const mask = masked ? buf.subarray(off, off + 4) : null
      const payload = Buffer.from(buf.subarray(off + (masked ? 4 : 0), need))
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]
      buf = buf.subarray(need)
      if (op === 8) { close(); return }
      if (op === 9) { sock.write(frame(10, payload)); continue }
      if (op === 0 || op === 1 || op === 2) tcp.write(payload)
    }
  })
})
server.listen(port, '0.0.0.0')
`

/**
 * Fixed script (no user input but a validated public key and the bridge token, passed as env):
 * ensure sshd (installs openssh-server once if the image lacks it), host keys, authorized key,
 * loopback key-only sshd, and the bridge. Idempotent per boot; prints one JSON line.
 */
export const SSH_START_SCRIPT = String.raw`
set -euo pipefail
d="$HOME/.orca-ssh"; mkdir -p "$d"; chmod 700 "$d"
# Golden images ship openssh-server; older ones get it once (persists on the sandbox disk).
if ! [ -x /usr/sbin/sshd ]; then
  if command -v dnf >/dev/null; then sudo -n dnf -y -q install openssh-server >/dev/null 2>&1 || true
  elif command -v apt-get >/dev/null; then sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends openssh-server >/dev/null 2>&1 || true; fi
  [ -x /usr/sbin/sshd ] || { echo '{"ok":false,"error":"sshd_unavailable"}'; exit 0; }
fi
[ -s "$d/ssh_host_ed25519_key" ] || ssh-keygen -q -t ed25519 -N '' -f "$d/ssh_host_ed25519_key"
mkdir -p "$HOME/.ssh"; chmod 700 "$HOME/.ssh"; touch "$HOME/.ssh/authorized_keys"; chmod 600 "$HOME/.ssh/authorized_keys"
if [ -n "${'$'}{ORCA_SSH_PUBKEY:-}" ] && ! grep -qxF "$ORCA_SSH_PUBKEY" "$HOME/.ssh/authorized_keys"; then printf '%s\n' "$ORCA_SSH_PUBKEY" >>"$HOME/.ssh/authorized_keys"; fi
# A locked account (shadow "!") refuses even key logins; "*" keeps passwords impossible but allows keys.
if sudo -n grep -q "^$(id -un):!" /etc/shadow 2>/dev/null; then sudo -n usermod -p '*' "$(id -un)"; fi
umask 077; printf '%s' "$ORCA_SSH_BRIDGE_TOKEN" >"$d/bridge-token"
cat >"$d/sshd_config" <<EOF
Port ${SSHD_PORT}
ListenAddress 127.0.0.1
HostKey $d/ssh_host_ed25519_key
PidFile $d/sshd.pid
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
PermitRootLogin no
AuthorizedKeysFile $HOME/.ssh/authorized_keys
AllowUsers $(id -un)
StrictModes no
Subsystem sftp internal-sftp
EOF
if ! { [ -s "$d/sshd.pid" ] && kill -0 "$(cat "$d/sshd.pid")" 2>/dev/null; }; then sudo -n mkdir -p /run/sshd 2>/dev/null || true; /usr/sbin/sshd -f "$d/sshd_config" -E "$d/sshd.log"; fi
cat >"$d/bridge.js" <<'BRIDGE'
${BRIDGE_JS}
BRIDGE
node="$(command -v node || find /opt/orca/runtime/runtimes -type f -name node | head -n 1)"
if ! { [ -s "$d/bridge.pid" ] && kill -0 "$(cat "$d/bridge.pid")" 2>/dev/null; }; then
  setsid nohup "$node" "$d/bridge.js" ${SSH_BRIDGE_PORT} ${SSHD_PORT} "$d/bridge-token" >"$d/bridge.log" 2>&1 </dev/null & echo $! >"$d/bridge.pid"
fi
for _ in $(seq 1 50); do curl -fsS -o /dev/null "http://127.0.0.1:${SSH_BRIDGE_PORT}/healthz" 2>/dev/null && break; sleep 0.1; done
printf '{"ok":true,"user":"%s"}\n' "$(id -un)"
`

/** OpenSSH public keys we accept for authorized_keys (one line, no options). */
export const SshPublicKeySchema = z
  .string()
  .max(1024)
  .regex(/^(ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa) [A-Za-z0-9+/=]{40,800}( [A-Za-z0-9@._-]{0,64})?$/)

const StartResult = z.union([
  z.object({ ok: z.literal(true), user: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/) }),
  z.object({ ok: z.literal(false), error: z.enum(['sshd_unavailable']) })
])

export class SshUnavailableError extends Error {
  constructor(readonly reason: 'sshd_unavailable' | 'no_bridge_route' | 'start_failed') {
    super(reason)
    this.name = 'SshUnavailableError'
  }
}

/** Starts sshd + bridge in a running session; returns the VM user to log in as. */
export async function startSshBridge(
  provider: SandboxProviderApi,
  sessionId: string,
  inputs: { publicKey?: string; bridgeToken: string }
): Promise<{ user: string }> {
  let stdout: string
  try {
    const result = await provider.runCommand(sessionId, {
      command: 'bash',
      args: ['-c', SSH_START_SCRIPT],
      env: { ORCA_SSH_BRIDGE_TOKEN: inputs.bridgeToken, ...(inputs.publicKey ? { ORCA_SSH_PUBKEY: inputs.publicKey } : {}) },
      timeoutMs: 120_000
    })
    if (result.exitCode !== 0) {
      throw new SshUnavailableError('start_failed')
    }
    stdout = result.stdout
  } catch (error) {
    if (error instanceof ProviderError) {
      throw new SshUnavailableError('start_failed')
    }
    throw error
  }
  const parsed = StartResult.safeParse(JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}'))
  if (!parsed.success) {
    throw new SshUnavailableError('start_failed')
  }
  if (!parsed.data.ok) {
    throw new SshUnavailableError(parsed.data.error)
  }
  return { user: parsed.data.user }
}

type SshRow = { sandbox_id: string; wake_secret_sha256: string; bridge_token: string; public_key: string }

function randomToken(bytes: number): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes))
  return btoa(String.fromCharCode(...raw)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false
  }
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

/**
 * Desktop (account-authenticated) SSH setup: authorizes `publicKey`, rotates the scoped wake
 * secret (returned once, stored hashed) and the bridge token. The ProxyCommand then needs only
 * the wake secret, never the user's Orca token.
 */
export async function setupSsh(db: D1Database, row: SandboxRow, publicKey: string, now: number): Promise<{ wakeSecret: string }> {
  const wakeSecret = `osw_${randomToken(32)}`
  await db
    .prepare(
      `INSERT INTO sandbox_ssh (sandbox_id, wake_secret_sha256, bridge_token, public_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (sandbox_id) DO UPDATE SET wake_secret_sha256 = excluded.wake_secret_sha256,
         bridge_token = excluded.bridge_token, public_key = excluded.public_key, updated_at = excluded.updated_at`
    )
    .bind(row.id, await sha256Hex(wakeSecret), randomToken(24), publicKey, now, now)
    .run()
  return { wakeSecret }
}

export async function sshRowForSecret(db: D1Database, sandboxId: string, secret: string): Promise<SshRow | null> {
  const stored = await db.prepare('SELECT * FROM sandbox_ssh WHERE sandbox_id = ?').bind(sandboxId).first<SshRow>()
  if (!stored || !secret) {
    return null
  }
  return timingSafeEqualHex(await sha256Hex(secret), stored.wake_secret_sha256) ? stored : null
}

/**
 * Wake on SSH: the same single-flight wake as every other source, then (once ready) start sshd and
 * the bridge for this boot. The endpoint carries the bridge token; SSH host keys and the user's key
 * still guard the session itself.
 */
export async function wakeForSsh(
  deps: LifecycleDeps,
  row: SandboxRow,
  ssh: SshRow,
  config: WorkspaceConfig & { waitMs: number }
): Promise<WakeAnswer> {
  let answer = await wakeSandbox(deps, row, config)
  if (answer.state !== 'ready') {
    return answer
  }
  let state = await deps.provider.getSandbox(row.provider_name, { resume: false })
  if (!state || state.session.status !== 'running') {
    // The row says running but the provider ended the session (crash, lease lapse not yet seen by
    // the cron): record the stop and wake for real instead of handing ssh a dead route.
    const current = await getSandbox(deps.db, row.id)
    if (current?.status === 'running') {
      answer = await wakeSandbox(deps, await markProviderStopped(deps, current), config)
      if (answer.state !== 'ready') {
        return answer
      }
      state = await deps.provider.getSandbox(row.provider_name, { resume: false })
    }
    if (!state || state.session.status !== 'running') {
      return { ...answer, state: 'waking', endpoint: null, readyAt: null }
    }
  }
  const route = state.routes.find((candidate) => candidate.port === SSH_BRIDGE_PORT)
  if (!route) {
    // Created before the bridge port existed: SSH needs a new workspace (or a provider port update).
    throw new SshUnavailableError('no_bridge_route')
  }
  await startSshBridge(deps.provider, state.session.id, { publicKey: ssh.public_key, bridgeToken: ssh.bridge_token })
  return { ...answer, endpoint: `${route.url.replace(/^https:/, 'wss:')}/?t=${encodeURIComponent(ssh.bridge_token)}` }
}

/** The VM's login user varies by golden image (Amazon Linux: vercel-sandbox, Ubuntu: ubuntu). */
export const DEFAULT_SSH_USER = 'vercel-sandbox'

/** Asks a running VM who it logs in as; the image default when it is asleep. */
export async function sshLoginUser(provider: SandboxProviderApi, row: SandboxRow): Promise<string> {
  if (row.status !== 'running' || !row.session_id) {
    return DEFAULT_SSH_USER
  }
  try {
    const result = await provider.runCommand(row.session_id, { command: 'id', args: ['-un'], timeoutMs: 10_000 })
    const user = result.stdout.trim()
    return result.exitCode === 0 && /^[a-z_][a-z0-9_-]{0,31}$/.test(user) ? user : DEFAULT_SSH_USER
  } catch {
    return DEFAULT_SSH_USER
  }
}
