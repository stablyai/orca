import { randomUUID } from 'node:crypto'
import type { RuntimeStatus } from '../../shared/runtime-types'
import {
  HOST_CREATE_FAILED_CODE,
  RECIPE_WORKSPACE_CREATE_PHASES,
  WORKSPACE_PROVIDERS_RUNTIME_CAPABILITY,
  WORKSPACE_PROVIDERS_SCHEMA_VERSION,
  isRecipeWorkspaceCreatePhase
} from '../../shared/recipe-workspace-create-progress'
import {
  formatWorkspaceProviderTarget,
  type WorkspaceProviderTarget
} from '../../shared/workspace-provider-target'
import type { RuntimeRpcProgress } from '../../shared/runtime-rpc-envelope'
import { RuntimeClientError, type RuntimeClient, type RuntimeRpcSuccess } from '../runtime-client'
import type { CliAgentLaunch } from '../agent-launch-request'
import { formatWorktreeShow, printResult } from '../format'
import { printHookWarning } from './worktree-removal-warnings'
import { printLineageSummary } from './worktree-lineage-summary'
import {
  launchOnNewHost,
  type ProviderWorktreeCreateResult
} from './worktree-create-provider-launch'
import { markProviderCreateError } from '../cli-exit-code'

// Idle bound only: the host sends a keepalive every few seconds while the provider runs, and the
// provider's own step timeouts (orca.yaml timeoutSeconds) bound the whole create.
const PROVIDER_CREATE_IDLE_TIMEOUT_MS = 600_000

export { WORKSPACE_FOLLOW_UP_FAILED_CODE } from './worktree-create-provider-launch'

function formatProviderCreated(value: ProviderWorktreeCreateResult): string {
  return [
    formatWorktreeShow(value),
    `host: ${value.host.id} (${value.host.origin.target}, ${value.host.checkoutMode})`,
    `environment: ${value.host.origin.runtimeId}`,
    ...(value.hostWarnings ?? []).map((warning) => `warning: ${warning}`)
  ].join('\n')
}

/** Providers run only where the Orca desktop app owns them; refuse before anything is created. */
export async function assertProviderHost(client: RuntimeClient): Promise<void> {
  if (client.isRemote) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Run provider commands on the computer whose Orca app owns the provider, without --environment or --pairing-code.',
      { field: 'environment' }
    )
  }
  const status = await client.call<RuntimeStatus>('status.get')
  if (!status.result.capabilities?.includes(WORKSPACE_PROVIDERS_RUNTIME_CAPABILITY)) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'This Orca has no workspace providers. Use the Orca desktop app on this computer, updated to the latest version.'
    )
  }
}

export type ProviderProgressMode = 'text' | 'json' | 'none'

export function readProviderProgressMode(
  flags: Map<string, string | boolean>,
  json: boolean
): ProviderProgressMode {
  const value = flags.get('progress')
  if (value === undefined) {
    return json ? 'none' : 'text'
  }
  if (value === 'text' || value === 'json' || value === 'none') {
    return value
  }
  throw new RuntimeClientError('invalid_argument', '--progress must be one of: text, json, none', {
    field: 'progress'
  })
}

function progressPrinter(mode: ProviderProgressMode): (progress: RuntimeRpcProgress) => void {
  return ({ phase, runtimeId }) => {
    if (mode === 'none' || !isRecipeWorkspaceCreatePhase(phase)) {
      return
    }
    if (mode === 'json') {
      process.stderr.write(
        `${JSON.stringify({ event: 'phase', phase, ...(runtimeId ? { runtimeId } : {}), at: Date.now() })}\n`
      )
      return
    }
    console.error(
      phase === 'host-recorded' && runtimeId
        ? `- Recorded the new environment (${runtimeId}).`
        : `- ${RECIPE_WORKSPACE_CREATE_PHASES[phase]}...`
    )
  }
}

/** Flags that need a provider which declares them; none do yet, so they are refused with a hint. */
export function assertProviderInputsSupported(
  flags: Map<string, string | boolean>,
  target: string
): void {
  for (const name of ['size', 'input', 'inputs-file']) {
    if (flags.has(name)) {
      throw new RuntimeClientError(
        'invalid_argument',
        `${target} declares no ${name === 'size' ? 'sizes' : 'inputs'}, so --${name} doesn't apply. See \`orca provider show ${target}\`.`,
        { field: name, target }
      )
    }
  }
}

/** `orca worktree create --on <provider>`: the host that owns the provider creates a new host, then the workspace. */
export async function createWorktreeOnProvider(
  args: Parameters<typeof createOnProvider>[0]
): Promise<void> {
  try {
    await createOnProvider(args)
  } catch (error) {
    throw markProviderCreateError(error)
  }
}

async function createOnProvider(args: {
  client: RuntimeClient
  flags: Map<string, string | boolean>
  create: Record<string, unknown>
  target: WorkspaceProviderTarget
  launch?: CliAgentLaunch
  json: boolean
}): Promise<void> {
  const { client, create, target, launch, json, flags } = args
  const spelled = formatWorkspaceProviderTarget(target)
  const progress = readProviderProgressMode(flags, json)
  assertProviderInputsSupported(flags, spelled)
  const parentFlag = ['parent-worktree', 'parent-environment'].find((name) => flags.has(name))
  if (parentFlag) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--${parentFlag} doesn't apply to provider creates yet: the new workspace lives on another host, so Orca records no parent for it.`,
      { field: parentFlag }
    )
  }
  if (flags.get('activate') === true) {
    throw new RuntimeClientError(
      'invalid_argument',
      "--activate doesn't apply to provider creates yet; open the new workspace from the Orca sidebar.",
      { field: 'activate' }
    )
  }
  if (launch?.operationId) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Retry the agent with `orca agent launch` on the existing workspace; --retry-launch would create another host.',
      { field: 'retry-launch' }
    )
  }
  const idempotencyKeyFlag = flags.get('idempotency-key')
  if (idempotencyKeyFlag === true || idempotencyKeyFlag === '') {
    throw new RuntimeClientError('invalid_argument', '--idempotency-key needs a value.', {
      field: 'idempotency-key'
    })
  }
  // Why: a retry with the same key returns the same workspace instead of creating a second machine.
  const idempotencyKey = typeof idempotencyKeyFlag === 'string' ? idempotencyKeyFlag : randomUUID()
  await assertProviderHost(client)
  // Why: a script that loses the reply needs the key before anything can fail, in every output mode.
  if (progress === 'json') {
    process.stderr.write(
      `${JSON.stringify({ event: 'started', target: spelled, idempotencyKey, at: Date.now() })}\n`
    )
  } else {
    console.error(
      progress === 'text'
        ? `Creating "${String(create.name)}" on a new host from ${spelled} (idempotency key ${idempotencyKey}). This can take several minutes; Ctrl+C stops it.`
        : `idempotency key: ${idempotencyKey}`
    )
  }
  // Set from a progress event inside the call; an object keeps TypeScript from narrowing it to null.
  const recorded: { runtimeId: string | null } = { runtimeId: null }
  const printProgress = progressPrinter(progress)
  let created: RuntimeRpcSuccess<ProviderWorktreeCreateResult>
  try {
    created = await client.call<ProviderWorktreeCreateResult>(
      'worktree.create',
      {
        // --run-hooks implies activation, which a workspace on another host can't do yet.
        ...create,
        activate: false,
        navigation: undefined,
        target,
        clientMutationId: idempotencyKey,
        ...(launch ? { createdWithAgent: launch.agent } : {})
      },
      {
        timeoutMs: PROVIDER_CREATE_IDLE_TIMEOUT_MS,
        onProgress: (event) => {
          if (event.phase === 'host-recorded' && event.runtimeId) {
            recorded.runtimeId = event.runtimeId
          }
          printProgress(event)
        }
      }
    )
  } catch (error) {
    if (error instanceof RuntimeClientError && error.code === HOST_CREATE_FAILED_CODE) {
      const data = typeof error.data === 'object' && error.data !== null ? error.data : {}
      const runtimeId =
        'host' in data &&
        typeof data.host === 'object' &&
        data.host !== null &&
        'runtimeId' in data.host
          ? String(data.host.runtimeId)
          : null
      throw new RuntimeClientError(error.code, error.message, {
        ...data,
        idempotencyKey,
        nextSteps: [
          ...(target.kind === 'recipe'
            ? [`Check the recipe with \`orca provider doctor ${spelled} --repo-path <repo>\`.`]
            : []),
          ...(runtimeId ? [`Check Settings > Cloud VMs in Orca for environment ${runtimeId}.`] : [])
        ]
      })
    }
    // Lost contact after the host was recorded: the machine may be up, so say so (exit 5).
    const recordedRuntimeId = recorded.runtimeId
    if (recordedRuntimeId !== null) {
      throw new RuntimeClientError(
        HOST_CREATE_FAILED_CODE,
        `${error instanceof Error ? error.message : String(error)} The new environment (${recordedRuntimeId}) may still be running; rerun with --idempotency-key ${idempotencyKey} or check Settings > Cloud VMs.`,
        {
          target: spelled,
          host: { runtimeId: recordedRuntimeId, state: 'unknown' },
          idempotencyKey,
          ...(error instanceof RuntimeClientError ? { cause: { code: error.code } } : {})
        }
      )
    }
    if (error instanceof RuntimeClientError) {
      throw new RuntimeClientError(error.code, error.message, {
        ...(typeof error.data === 'object' && error.data !== null ? error.data : {}),
        idempotencyKey
      })
    }
    throw error
  }
  const result = {
    ...created.result,
    schemaVersion: WORKSPACE_PROVIDERS_SCHEMA_VERSION,
    idempotencyKey
  }
  printHookWarning(result, json)
  if (!launch) {
    printLineageSummary(result, json)
    printResult({ ...created, result }, json, formatProviderCreated)
    return
  }
  await launchOnNewHost({
    client,
    flags,
    launch,
    json,
    created: { ...created, result },
    format: formatProviderCreated
  })
}
