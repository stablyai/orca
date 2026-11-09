// Commands the golden image installs in /opt/orca/bin (see image/provision-golden.sh). The control
// plane only ever runs these fixed entry points in a VM, never user-supplied command lines.
import { z } from 'zod'
import { ProviderError, type ProviderSandboxState, type SandboxProviderApi } from './sandbox-provider'

export const ORCAD_PORT = 6768
export const START_COMMAND = '/opt/orca/bin/orca-sandbox-start'
export const DRAIN_COMMAND = '/opt/orca/bin/orca-sandbox-drain'
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
  constructor(readonly code: 'orcad_start_failed' | 'orcad_ready_invalid' | 'route_missing') {
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
  const env: Record<string, string> = {
    ORCA_SANDBOX_ID: inputs.sandboxId,
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
  const result = await provider.runCommand(state.session.id, {
    command: START_COMMAND,
    env,
    timeoutMs: START_TIMEOUT_MS
  })
  if (result.exitCode !== 0) {
    throw new VmCommandError('orcad_start_failed')
  }
  const lastLine = result.stdout.trim().split('\n').at(-1) ?? ''
  try {
    return ReadySchema.parse(JSON.parse(lastLine))
  } catch {
    throw new VmCommandError('orcad_ready_invalid')
  }
}

/** Best effort: orcad turns working chats into durable restart offers before the VM stops. */
export async function drainOrcad(provider: SandboxProviderApi, sessionId: string): Promise<boolean> {
  try {
    const result = await provider.runCommand(sessionId, {
      command: DRAIN_COMMAND,
      timeoutMs: DRAIN_TIMEOUT_MS
    })
    return result.exitCode === 0
  } catch (error) {
    if (error instanceof ProviderError) {
      return false
    }
    throw error
  }
}
