import { ipcMain } from 'electron'
import { z } from 'zod'
import {
  CreateCloudApiApprovalInputSchema,
  CreateCloudApiKeyInputSchema,
  RoutineInputSchema,
  RoutinePatchSchema,
  RoutineRunsQuerySchema,
  type CloudApiResult
} from '../../shared/cloud-api/cloud-api-types'
import type { CloudApiClient } from './cloud-api-client'
import { callCloudApi, getCloudApiAvailability } from './cloud-api-service'

const Id = z.string().min(1).max(128)
const AuditQuery = z
  .object({
    limit: z.number().int().min(1).max(200).optional(),
    before: z.number().int().nonnegative().optional()
  })
  .strict()
const SettingsInput = z.object({ vmCliEnabled: z.boolean() }).strict()

type Handler = (...args: unknown[]) => Promise<CloudApiResult<unknown>>

/** Validates renderer input before it reaches the network; bad input never leaves main. */
function call<A extends unknown[]>(
  schemas: { [K in keyof A]: z.ZodType<A[K]> },
  run: (client: CloudApiClient, ...args: A) => Promise<unknown>
): Handler {
  return async (...raw) => {
    const parsed: unknown[] = []
    for (const [index, schema] of schemas.entries()) {
      const result = schema.safeParse(raw[index])
      if (!result.success) {
        return { ok: false, error: 'invalid-request' }
      }
      parsed.push(result.data)
    }
    return callCloudApi((client) => run(client, ...(parsed as A)))
  }
}

const HANDLERS: Record<string, Handler> = {
  'cloudApi:me': call([], (c) => c.me()),
  'cloudApi:listApiKeys': call([], (c) => c.listApiKeys()),
  'cloudApi:createApiKey': call([CreateCloudApiKeyInputSchema], (c, input) =>
    c.createApiKey(input)
  ),
  'cloudApi:revokeApiKey': call([Id], (c, id) => c.revokeApiKey(id)),
  'cloudApi:createApproval': call([CreateCloudApiApprovalInputSchema.optional()], (c, input) =>
    c.createApproval(input ?? {})
  ),
  'cloudApi:getSettings': call([], (c) => c.getSettings()),
  'cloudApi:putSettings': call([SettingsInput], (c, input) => c.putSettings(input)),
  'cloudApi:listAudit': call([AuditQuery.optional()], (c, q) => c.listAudit(q ?? {})),
  'cloudApi:listProjects': call([], (c) => c.listProjects()),
  'cloudApi:listInstallations': call([], (c) => c.listInstallations()),
  'cloudApi:listRoutines': call([], (c) => c.listRoutines()),
  'cloudApi:createRoutine': call([RoutineInputSchema], (c, input) => c.createRoutine(input)),
  'cloudApi:updateRoutine': call([Id, RoutinePatchSchema], (c, id, patch) =>
    c.updateRoutine(id, patch)
  ),
  'cloudApi:deleteRoutine': call([Id], (c, id) => c.deleteRoutine(id)),
  'cloudApi:runRoutine': call([Id], (c, id) => c.runRoutine(id)),
  'cloudApi:rotateRoutineWebhook': call([Id], (c, id) => c.rotateRoutineWebhook(id)),
  'cloudApi:listRoutineRuns': call([Id, RoutineRunsQuerySchema.optional()], (c, id, q) =>
    c.listRoutineRuns(id, q ?? {})
  )
}

export const CLOUD_API_CHANNELS = ['cloudApi:availability', ...Object.keys(HANDLERS)]

/** Exposed for tests: the validated handler behind a channel. */
export function cloudApiHandlerFor(channel: string): Handler | undefined {
  return HANDLERS[channel]
}

export function registerCloudApiHandlers(): void {
  for (const channel of CLOUD_API_CHANNELS) {
    ipcMain.removeHandler(channel)
  }
  ipcMain.handle('cloudApi:availability', () => getCloudApiAvailability())
  for (const [channel, handler] of Object.entries(HANDLERS)) {
    ipcMain.handle(channel, (_event, ...args: unknown[]) => handler(...args))
  }
}
