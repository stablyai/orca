// Renderer bridge to Orca Cloud secrets. Values travel renderer -> main -> control plane once per save;
// nothing returns them, and failures surface as codes only (an error message could quote a value).
import { app, ipcMain } from 'electron'
import { z } from 'zod'
import {
  CLOUD_SECRET_SCOPES,
  MAX_CLOUD_SECRET_BATCH,
  type CloudSecretsResult,
  type CloudSecretsStatus
} from '../../shared/cloud-secrets/cloud-secrets-wire'
import { listEphemeralVmRuntimes } from '../../shared/ephemeral-vm-runtime-store'
import { environmentHandleFromRecipeResult } from '../environment-providers/environment-provider-recipe-adapter'
import { getHostedSandboxConfig } from '../hosted-sandbox/hosted-sandbox-config'
import { HOSTED_SANDBOX_DRIVER_ID } from '../hosted-sandbox/hosted-sandbox-driver'
import { getOrcaCloudAvailability } from '../hosted-sandbox/hosted-sandbox-install'
import {
  cloudSecretsFailureCode,
  createCloudSecretsClient,
  type CloudSecretsClient
} from './cloud-secrets-client'

const Repo = z.string().trim().min(3).max(256)
const Target = z.object({ scope: z.enum(CLOUD_SECRET_SCOPES), repo: Repo.optional() })
const Name = z.string().min(1).max(128)
const Value = z
  .string()
  .min(1)
  .max(64 * 1024)
const PutRequest = z.object({ target: Target, name: Name, value: Value })
const RemoveRequest = z.object({ target: Target, name: Name })
const BatchRequest = z
  .object({
    target: Target,
    set: z.record(Name, Value).optional(),
    delete: z.array(Name).max(MAX_CLOUD_SECRET_BATCH).optional()
  })
  .refine(
    (request) =>
      Object.keys(request.set ?? {}).length + (request.delete?.length ?? 0) <=
      MAX_CLOUD_SECRET_BATCH
  )
const EffectiveRequest = z.object({ repo: Repo.optional() })
const RefreshRequest = z.object({ runtimeEnvironmentId: z.string().min(1).max(256) })

const CHANNELS = [
  'cloudSecrets:status',
  'cloudSecrets:list',
  'cloudSecrets:put',
  'cloudSecrets:remove',
  'cloudSecrets:batch',
  'cloudSecrets:effective',
  'cloudSecrets:refreshEnv'
] as const

async function attempt<T>(
  client: CloudSecretsClient | null,
  run: (client: CloudSecretsClient) => Promise<T>
): Promise<CloudSecretsResult<T>> {
  if (!client) {
    return { ok: false, error: 'not_configured' }
  }
  try {
    return { ok: true, value: await run(client) }
  } catch (error) {
    const code = cloudSecretsFailureCode(error)
    console.warn(`[cloud-secrets] request failed: ${code}`)
    return { ok: false, error: code }
  }
}

function sandboxIdFor(userDataPath: string, runtimeEnvironmentId: string): string | null {
  const runtime = listEphemeralVmRuntimes(userDataPath).find(
    (record) =>
      record.runtimeEnvironmentId === runtimeEnvironmentId &&
      record.recipe?.provider === 'orca-cloud'
  )
  const handle = runtime?.recipeResult
    ? environmentHandleFromRecipeResult(runtime.recipeResult, HOSTED_SANDBOX_DRIVER_ID)
    : null
  return handle?.environmentId ?? null
}

export function registerCloudSecretsHandlers(userDataPath: string): void {
  const config = getHostedSandboxConfig(userDataPath, process.env, app.isPackaged)
  const client = config
    ? createCloudSecretsClient({
        baseUrl: config.controlPlaneUrl,
        getAccessToken: config.getAccessToken
      })
    : null
  for (const channel of CHANNELS) {
    ipcMain.removeHandler(channel)
  }
  const invalid = { ok: false, error: 'invalid_value' } as const

  ipcMain.handle('cloudSecrets:status', async (): Promise<CloudSecretsStatus> => ({
    available: client !== null && (await getOrcaCloudAvailability()) === 'offered'
  }))
  ipcMain.handle('cloudSecrets:list', (_event, raw: unknown) => {
    const target = Target.safeParse(raw)
    return target.success ? attempt(client, (c) => c.list(target.data)) : invalid
  })
  ipcMain.handle('cloudSecrets:put', (_event, raw: unknown) => {
    const request = PutRequest.safeParse(raw)
    return request.success
      ? attempt(client, (c) => c.put(request.data.target, request.data.name, request.data.value))
      : invalid
  })
  ipcMain.handle('cloudSecrets:remove', (_event, raw: unknown) => {
    const request = RemoveRequest.safeParse(raw)
    return request.success
      ? attempt(client, async (c) => {
          await c.remove(request.data.target, request.data.name)
          return true as const
        })
      : invalid
  })
  ipcMain.handle('cloudSecrets:batch', (_event, raw: unknown) => {
    const request = BatchRequest.safeParse(raw)
    return request.success
      ? attempt(client, (c) =>
          c.batch(request.data.target, { set: request.data.set, delete: request.data.delete })
        )
      : invalid
  })
  ipcMain.handle('cloudSecrets:effective', (_event, raw: unknown) => {
    const request = EffectiveRequest.safeParse(raw ?? {})
    return request.success ? attempt(client, (c) => c.effective(request.data.repo)) : invalid
  })
  ipcMain.handle('cloudSecrets:refreshEnv', (_event, raw: unknown) => {
    const request = RefreshRequest.safeParse(raw)
    if (!request.success) {
      return invalid
    }
    const sandboxId = sandboxIdFor(userDataPath, request.data.runtimeEnvironmentId)
    return sandboxId
      ? attempt(client, (c) => c.refreshEnv(sandboxId))
      : { ok: false, error: 'not_found' }
  })
}
