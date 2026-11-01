import type { z } from 'zod'
import type { AcpLoadedSessionBody } from './acp-dialects/acp-dialect'
import { AcpAuthRequiredError, AcpRpcError, acpAuthRequiredError } from './acp-errors'
import {
  NewSessionResponseSchema,
  LoadSessionResponseSchema,
  ResumeSessionResponseSchema,
  AuthenticateResponseSchema,
  SessionModelStateSchema,
  type InitializeResponse,
  type NewSessionRequest
} from './generated/acp-protocol.generated'

const newSessionSchema = NewSessionResponseSchema.extend({
  models: SessionModelStateSchema.optional()
})
const loadSessionSchema = LoadSessionResponseSchema.extend({
  models: SessionModelStateSchema.optional()
})
const resumeSessionSchema = ResumeSessionResponseSchema.extend({
  models: SessionModelStateSchema.optional()
})

export type AcpSessionStarted =
  | { kind: 'new'; sessionId: string; response: z.infer<typeof newSessionSchema> }
  | { kind: 'load'; sessionId: string; response: z.infer<typeof loadSessionSchema> }
  | { kind: 'resume'; sessionId: string; response: z.infer<typeof resumeSessionSchema> }
export type AcpSessionStartOptions = NewSessionRequest & {
  sessionId?: string
  resumePreference?: 'load' | 'resume'
  authMethodId?: string
  /** When set, an accepted load can still mean the session is gone. */
  loadedSessionMissing?: (response: AcpLoadedSessionBody) => boolean
}
type Request = <T>(method: string, params: unknown, schema: z.ZodType<T>) => Promise<T>

export async function setupAcpSession(
  initialized: InitializeResponse,
  options: AcpSessionStartOptions,
  request: Request
): Promise<AcpSessionStarted> {
  const setup = async (): Promise<AcpSessionStarted> => {
    const {
      sessionId,
      resumePreference,
      authMethodId: _auth,
      loadedSessionMissing,
      ...params
    } = options
    if (sessionId === undefined) {
      const response = await request('session/new', params, newSessionSchema)
      return { kind: 'new', sessionId: response.sessionId, response }
    }
    const capabilities = initialized.agentCapabilities
    const load = capabilities?.loadSession === true
    const resume = capabilities?.sessionCapabilities?.resume != null
    if (load && (resumePreference !== 'resume' || !resume)) {
      const response = await request('session/load', { ...params, sessionId }, loadSessionSchema)
      // Same code a missing session reports, so reopen starts a new one.
      if (loadedSessionMissing?.(response)) {
        throw new AcpRpcError(-32002, 'Resource not found')
      }
      return { kind: 'load', sessionId, response }
    }
    if (resume) {
      return {
        kind: 'resume',
        sessionId,
        response: await request('session/resume', { ...params, sessionId }, resumeSessionSchema)
      }
    }
    throw new AcpRpcError(-32601, 'ACP agent cannot load or resume this session')
  }
  try {
    return await setup()
  } catch (error) {
    if (!(error instanceof AcpAuthRequiredError)) {
      throw error
    }
    const required = acpAuthRequiredError(error, initialized.authMethods)
    const method = initialized.authMethods?.find((method) => method.id === options.authMethodId)
    if (!method) {
      throw required
    }
    try {
      await request('authenticate', { methodId: method.id }, AuthenticateResponseSchema)
      return await setup()
    } catch (failure) {
      if (failure instanceof AcpAuthRequiredError) {
        throw acpAuthRequiredError(failure, initialized.authMethods)
      }
      throw failure
    }
  }
}
