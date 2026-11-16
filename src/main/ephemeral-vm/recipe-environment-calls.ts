import type { RuntimeRpcResponse } from '../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type {
  ProjectHostSetupExistingFolderArgs,
  ProjectHostSetupResult,
  ProjectProviderIdentity
} from '../../shared/project/project-types'
import { parseExecutionHostId } from '../../shared/execution-host/execution-host'
import { WORKSPACE_RUN_CONTEXT_RUNTIME_CAPABILITY } from '../../shared/remote-runtime/protocol/worktree-runtime-capabilities'
import { redactEphemeralVmRecipeDiagnosticText } from '../../shared/remote-runtime/ephemeral-vm-recipes/ephemeral-vm-recipe-diagnostic-redaction'
import {
  ENVIRONMENT_DOCTOR_CHECK_TIMEOUT_MS,
  ENVIRONMENT_DOCTOR_METHOD,
  ENVIRONMENT_DOCTOR_RUNTIME_CAPABILITY
} from '../../shared/workspace-setup/environment-doctor/environment-doctor-runtime'
import {
  isEnvironmentDoctorCheck,
  type EnvironmentDoctorCheck,
  type EnvironmentDoctorResult
} from '../../shared/workspace-setup/environment-doctor/environment-doctor-types'

const STATUS_TIMEOUT_MS = 15_000
// The renderer's limit for the same project setup calls.
const PROJECT_SETUP_TIMEOUT_MS = 15_000

export type RecipeEnvironmentCallPort = (
  environmentId: string,
  method: string,
  params: unknown,
  options: { timeoutMs: number; signal?: AbortSignal }
) => Promise<RuntimeRpcResponse<unknown>>

/** Calls to the new environment's own Orca for one create; capabilities are read once. */
export function createRecipeEnvironmentCalls(
  callPort: RecipeEnvironmentCallPort,
  signal: AbortSignal | undefined
) {
  const capabilities = new Map<string, Promise<readonly string[]>>()
  // Cleanup must outlive a cancelled request, so it passes `withSignal: false`.
  const call = async (
    environmentId: string,
    method: string,
    params: unknown,
    timeoutMs: number,
    withSignal = true
  ): Promise<unknown> => {
    const callSignal = withSignal ? signal : undefined
    callSignal?.throwIfAborted()
    const response = await callPort(environmentId, method, params, {
      timeoutMs,
      ...(callSignal ? { signal: callSignal } : {})
    })
    if (!response.ok) {
      throw new Error(redactEphemeralVmRecipeDiagnosticText(response.error.message))
    }
    return response.result
  }
  const readCapabilities = (environmentId: string): Promise<readonly string[]> => {
    let pending = capabilities.get(environmentId)
    if (!pending) {
      pending = call(environmentId, 'status.get', undefined, STATUS_TIMEOUT_MS).then((status) =>
        typeof status === 'object' &&
        status !== null &&
        'capabilities' in status &&
        Array.isArray(status.capabilities)
          ? status.capabilities.filter((entry): entry is string => typeof entry === 'string')
          : []
      )
      capabilities.set(environmentId, pending)
    }
    return pending
  }
  const assertCapability = async (
    environmentId: string,
    capability: string,
    message: string
  ): Promise<void> => {
    if (!(await readCapabilities(environmentId)).includes(capability)) {
      throw new Error(message)
    }
  }
  /**
   * The checks the dialog's build sheet runs before it creates the workspace; null when the
   * environment's Orca predates them. A call that could not finish counts as a failed check.
   */
  const checkEnvironment = async (
    environmentId: string,
    path: string
  ): Promise<Pick<EnvironmentDoctorResult, 'ok' | 'checks'> | null> => {
    if (!(await readCapabilities(environmentId)).includes(ENVIRONMENT_DOCTOR_RUNTIME_CAPABILITY)) {
      return null
    }
    try {
      const result = await call(
        environmentId,
        ENVIRONMENT_DOCTOR_METHOD,
        { path },
        ENVIRONMENT_DOCTOR_CHECK_TIMEOUT_MS
      )
      if (typeof result !== 'object' || result === null) {
        return { ok: false, checks: [] }
      }
      return {
        ok: 'ok' in result && result.ok === true,
        checks:
          'checks' in result && Array.isArray(result.checks)
            ? result.checks.filter(isEnvironmentDoctorCheck)
            : []
      }
    } catch (error) {
      signal?.throwIfAborted()
      const unreachable: EnvironmentDoctorCheck = {
        id: 'environment.doctor',
        category: 'workspace',
        status: 'fail',
        message: `The environment checks could not finish: ${error instanceof Error ? error.message : String(error)}`
      }
      return { ok: false, checks: [unreachable] }
    }
  }
  /** The renderer store's project setup on a runtime host, without its catalog and toasts. */
  const setupProject = async (
    setupArgs: ProjectHostSetupExistingFolderArgs,
    projectProviderIdentity: ProjectProviderIdentity | undefined
  ): Promise<ProjectHostSetupResult | null> => {
    const host = parseExecutionHostId(setupArgs.hostId)
    if (host?.kind !== 'runtime') {
      throw new Error(
        "This recipe's environment does not run an Orca server, so the CLI cannot create a workspace on it."
      )
    }
    await assertCapability(
      host.environmentId,
      WORKSPACE_RUN_CONTEXT_RUNTIME_CAPABILITY,
      'The selected Orca server does not support explicit workspace run hosts yet. Update Orca on the server and try again.'
    )
    const response = await call(
      host.environmentId,
      'projectHostSetup.setupExistingFolder',
      { ...setupArgs, ...(projectProviderIdentity ? { projectProviderIdentity } : {}) },
      PROJECT_SETUP_TIMEOUT_MS
    )
    return typeof response === 'object' &&
      response !== null &&
      'result' in response &&
      isProjectHostSetupResult(response.result)
      ? response.result
      : null
  }
  const deleteProject = (environmentId: string, setupId: string): Promise<unknown> =>
    call(environmentId, 'projectHostSetup.delete', { setupId }, PROJECT_SETUP_TIMEOUT_MS, false)
  return { call, assertCapability, checkEnvironment, setupProject, deleteProject }
}

/** What a create needs from the new host's answer: the repo it registered and its setup. */
function isProjectHostSetupResult(value: unknown): value is ProjectHostSetupResult {
  if (typeof value !== 'object' || value === null || !('repo' in value) || !('setup' in value)) {
    return false
  }
  const { repo, setup } = value
  return (
    typeof repo === 'object' &&
    repo !== null &&
    'id' in repo &&
    typeof repo.id === 'string' &&
    repo.id.length > 0 &&
    'path' in repo &&
    typeof repo.path === 'string' &&
    repo.path.length > 0 &&
    typeof setup === 'object' &&
    setup !== null &&
    'id' in setup &&
    typeof setup.id === 'string' &&
    setup.id.length > 0
  )
}
