// Commands the golden image installs in /opt/orca/bin (see image/provision-golden.sh). The control
// plane only ever runs these fixed entry points in a VM, never user-supplied command lines.
import { z } from 'zod'
import { createReadyKey, READY_VIA_FILE_ENV, resolveOrcadReadyLine } from './orcad-ready'
import { ProviderError, type ProviderSandboxState, type SandboxProviderApi } from './sandbox-provider'

export const ORCAD_PORT = 6768
/** In-VM share-link proxy (image/vm/orca-share-proxy); only answers gateway-signed requests. */
export const SHARE_PROXY_PORT = 6769
export const START_COMMAND = '/opt/orca/bin/orca-sandbox-start'
export const DRAIN_COMMAND = '/opt/orca/bin/orca-sandbox-drain'
export const ENV_COMMAND = '/opt/orca/bin/orca-sandbox-env'
const ENV_TIMEOUT_MS = 30_000
const START_TIMEOUT_MS = 120_000
/** Matches the parity plan: in-flight turns get up to 5 min to become durable restart offers. */
export const DRAIN_TIMEOUT_MS = 5 * 60_000

const ReadySchema = z
  .object({
    // `orcad --recipe-json` prints the recipe line schemaVersion 1.
    schemaVersion: z.literal(1).optional(),
    pairingCode: z.string().min(1).max(8192),
    projectRoot: z.string().startsWith('/').max(4096)
  })
  .strict()

export type OrcadReady = z.infer<typeof ReadySchema>

export class VmCommandError extends Error {
  constructor(readonly code: 'orcad_start_failed' | 'orcad_ready_invalid' | 'route_missing' | 'ssh_keys_failed') {
    super(code)
    this.name = 'VmCommandError'
  }
}

export type StartInputs = {
  sandboxId: string
  repo?: { url: string; ref?: string }
  /** Token the VM's GitHub clients send; the egress layer swaps it for a real short-lived one. */
  githubPlaceholder?: string
  /** git `http.https://github.com/.extraheader` carrying the placeholder, so every git request is claimable. */
  gitExtraHeader?: string
  /** Secrets for orcad's (and so every agent's) process env. Never written to disk in the VM. */
  secretEnv?: Record<string, string>
  /**
   * First boot only: bash run before the start script (stdout redirected to stderr), e.g. linking an
   * environment build's prebuilt repo as the project. Its failure never blocks the start.
   */
  prelude?: { script: string; env?: Record<string, string> }
  /** This session's share-proxy key (src/share-crypto.ts); the proxy keeps it in memory only. */
  shareProxyKey?: string
}

/** `NAME=<base64 utf-8 value>` lines, so values with newlines or quotes survive bash intact. */
export function encodeSecretEnv(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([name, value]) => {
      let binary = ''
      for (const byte of new TextEncoder().encode(value)) {
        binary += String.fromCharCode(byte)
      }
      return `${name}=${btoa(binary)}`
    })
    .join('\n')
}

/** Starts orcad (idempotent per boot) and returns its pairing offer; pairing codes are never logged. */
export async function startOrcad(
  provider: SandboxProviderApi,
  state: ProviderSandboxState,
  inputs: StartInputs
): Promise<OrcadReady> {
  const route = state.routes.find((candidate) => candidate.port === ORCAD_PORT)
  if (!route) {
    throw new VmCommandError('route_missing')
  }
  const readyKey = createReadyKey()
  const env: Record<string, string> = {
    ...READY_VIA_FILE_ENV,
    ...readyKey.env,
    ORCA_SANDBOX_ID: inputs.sandboxId,
    ORCA_ENV_GENERATION: String(Date.now()),
    ORCA_PUBLIC_WSS: route.url.replace(/^https:/, 'wss:')
  }
  if (inputs.repo) {
    env.ORCA_REPO_URL = inputs.repo.url
    if (inputs.repo.ref) {
      env.ORCA_REPO_REF = inputs.repo.ref
    }
  }
  if (inputs.gitExtraHeader) {
    env.ORCA_GIT_EXTRAHEADER = inputs.gitExtraHeader
  }
  if (inputs.githubPlaceholder) {
    env.ORCA_GITHUB_PLACEHOLDER = inputs.githubPlaceholder
  }
  if (inputs.secretEnv && Object.keys(inputs.secretEnv).length > 0) {
    env.ORCA_SECRET_ENV = encodeSecretEnv(inputs.secretEnv)
  }
  if (inputs.shareProxyKey) {
    env.ORCA_SHARE_PROXY_KEY = inputs.shareProxyKey
  }
  // The prelude rides in an env var (the start script's `env -i` keeps it out of orcad) so one
  // round trip both prepares the checkout and starts orcad.
  const result = await provider.runCommand(
    state.session.id,
    inputs.prelude
      ? {
          command: 'bash',
          // The prelude never sees the share-proxy or ready keys; only the start script gets them.
          args: ['-c', `env -u ORCA_SHARE_PROXY_KEY -u ORCA_READY_KEY bash -c "$ORCA_PRELUDE" 1>&2 || true; unset ORCA_PRELUDE; exec ${START_COMMAND}`],
          env: { ...env, ...inputs.prelude.env, ORCA_PRELUDE: inputs.prelude.script },
          timeoutMs: START_TIMEOUT_MS
        }
      : { command: START_COMMAND, env, timeoutMs: START_TIMEOUT_MS }
  )
  if (result.exitCode !== 0) {
    throw new VmCommandError('orcad_start_failed')
  }
  const lastLine = result.stdout.trim().split('\n').at(-1) ?? ''
  try {
    return ReadySchema.parse(await resolveOrcadReadyLine(provider, state.session.id, lastLine, readyKey.key))
  } catch {
    throw new VmCommandError('orcad_ready_invalid')
  }
}

/**
 * The orcad already serving this boot, read without taking the start lock (images before the fd-9 fix
 * leaked that lock into orcad, so a second start waited 60 s and failed). Null when none is up.
 */
export async function runningOrcad(provider: SandboxProviderApi, sessionId: string): Promise<OrcadReady | null> {
  const script = [
    'S="$HOME/.orca-sandbox"',
    '[ "$(cat "$S/boot-id" 2>/dev/null)" = "$(cat /proc/sys/kernel/random/boot_id)" ] || exit 3',
    'kill -0 "$(cat "$S/orcad.pid" 2>/dev/null || echo 0)" 2>/dev/null || exit 3',
    'grep -q \'"pairingCode"\' "$S/ready.json" 2>/dev/null || exit 3',
    // A pointer, not the offer: command stdout is retained by the provider (see orcad-ready.ts).
    'printf \'{"schemaVersion":1,"readyFile":"%s"}\\n\' "$S/ready.json"'
  ].join('\n')
  try {
    const result = await provider.runCommand(sessionId, { command: 'bash', args: ['-c', script], timeoutMs: 15_000 })
    if (result.exitCode !== 0) {
      return null
    }
    return ReadySchema.parse(await resolveOrcadReadyLine(provider, sessionId, result.stdout.trim().split('\n').at(-1) ?? ''))
  } catch (error) {
    if (error instanceof ProviderError || error instanceof SyntaxError || error instanceof z.ZodError) {
      return null
    }
    throw error
  }
}

/**
 * Replaces the session's memory-only env file in the VM; new shells and agent launches read it.
 * False when the image predates the command (older golden image): the next boot applies it.
 */
export async function refreshSessionEnv(
  provider: SandboxProviderApi,
  sessionId: string,
  secretEnv: Record<string, string>,
  /** Monotonic (ms): the VM ignores a write older than the one it already has. */
  generation: number
): Promise<boolean> {
  const result = await provider.runCommand(sessionId, {
    command: ENV_COMMAND,
    env: { ORCA_SECRET_ENV: encodeSecretEnv(secretEnv), ORCA_ENV_GENERATION: String(generation) },
    timeoutMs: ENV_TIMEOUT_MS
  })
  return result.exitCode === 0
}

/** Best effort: orcad turns working chats into durable restart offers before the VM stops. */
export async function drainOrcad(provider: SandboxProviderApi, sessionId: string, waitSeconds?: number): Promise<boolean> {
  try {
    const result = await provider.runCommand(sessionId, {
      command: DRAIN_COMMAND,
      // The script's own default (280s) leaves room inside DRAIN_TIMEOUT_MS; Restart passes a short wait.
      ...(waitSeconds ? { args: [String(Math.max(1, Math.floor(waitSeconds)))] } : {}),
      timeoutMs: waitSeconds ? (waitSeconds + 20) * 1000 : DRAIN_TIMEOUT_MS
    })
    return result.exitCode === 0
  } catch (error) {
    if (error instanceof ProviderError) {
      return false
    }
    throw error
  }
}

export const DESKTOP_COMMAND = '/opt/orca/bin/orca-desktop-start'
/** noVNC on the VM's loopback; reached only through the paired forward, never shared. */
export const DESKTOP_PORT = 6080
const DESKTOP_TIMEOUT_MS = 45_000
/** orca-desktop-start's exit code for an image built without the remote desktop. */
const DESKTOP_NOT_INSTALLED_EXIT = 3

const DesktopReadySchema = z
  .object({
    schemaVersion: z.literal(2),
    port: z.number().int().min(1024).max(65_535),
    display: z.string().regex(/^:\d{1,3}$/),
    path: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
    /**
     * Single-use connection ticket (32 random bytes, base64url): the desktop's localhost forward is
     * reachable by any local process, so the VM's proxy admits one WebSocket per unexpired ticket.
     */
    ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    expiresInMs: z.number().int().min(1_000).max(300_000)
  })
  .strict()

export type DesktopReady = z.infer<typeof DesktopReadySchema>

export class DesktopCommandError extends Error {
  constructor(readonly code: 'desktop_not_installed' | 'desktop_start_failed' | 'desktop_ready_invalid') {
    super(code)
    this.name = 'DesktopCommandError'
  }
}

/** Starts the VM's remote desktop (idempotent per boot) and mints one ticket: Xvnc + noVNC on the VM's loopback only. */
export async function startDesktop(provider: SandboxProviderApi, sessionId: string): Promise<DesktopReady> {
  let result: Awaited<ReturnType<SandboxProviderApi['runCommand']>>
  try {
    result = await provider.runCommand(sessionId, { command: DESKTOP_COMMAND, timeoutMs: DESKTOP_TIMEOUT_MS })
  } catch (error) {
    // Vercel refuses to spawn a missing executable: an image from before the desktop.
    if (error instanceof ProviderError && error.status === 400 && error.code === 'command_failed') {
      throw new DesktopCommandError('desktop_not_installed')
    }
    throw error
  }
  if (result.exitCode === DESKTOP_NOT_INSTALLED_EXIT || result.exitCode === 127) {
    throw new DesktopCommandError('desktop_not_installed')
  }
  if (result.exitCode !== 0) {
    throw new DesktopCommandError('desktop_start_failed')
  }
  try {
    return DesktopReadySchema.parse(JSON.parse(result.stdout.trim().split('\n').at(-1) ?? ''))
  } catch {
    throw new DesktopCommandError('desktop_ready_invalid')
  }
}
