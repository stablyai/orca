import type { z } from 'zod'
import { AcpAuthRequiredError, AcpRpcError } from './acp-errors'
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
}
type Request = <T>(method: string, params: unknown, schema: z.ZodType<T>) => Promise<T>

export async function setupAcpSession(
  initialized: InitializeResponse,
  options: AcpSessionStartOptions,
  request: Request
): Promise<AcpSessionStarted> {
  const setup = async (): Promise<AcpSessionStarted> => {
    const { sessionId, resumePreference, authMethodId: _auth, ...params } = options
    if (sessionId === undefined) {
      const response = await request('session/new', params, newSessionSchema)
      return { kind: 'new', sessionId: response.sessionId, response }
    }
    const capabilities = initialized.agentCapabilities
    const load = capabilities?.loadSession === true
    const resume = capabilities?.sessionCapabilities?.resume != null
    if (load && (resumePreference !== 'resume' || !resume)) {
      return {
        kind: 'load',
        sessionId,
        response: await request('session/load', { ...params, sessionId }, loadSessionSchema)
      }
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
    const required = new AcpAuthRequiredError(error.message, error.data, initialized.authMethods)
    const method = initialized.authMethods?.find((method) => method.id === options.authMethodId)
    if (!method) {
      throw required
    }
    try {
      await request('authenticate', { methodId: method.id }, AuthenticateResponseSchema)
      return await setup()
    } catch (failure) {
      if (failure instanceof AcpAuthRequiredError) {
        throw new AcpAuthRequiredError(failure.message, failure.data, initialized.authMethods)
      }
      throw failure
    }
  }
}
