import {
  providerDiagnostic,
  withProviderDiagnostic
} from '../../shared/agent-session/failures/agent-session-failure'
import type { z } from 'zod'
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
  authMethodUnavailableMessage?: string
}
type Request = <T>(
  method: string,
  params: unknown,
  schema: z.ZodType<T>,
  received?: (response: T) => void
) => Promise<T>

export async function setupAcpSession(
  initialized: InitializeResponse,
  options: AcpSessionStartOptions,
  request: Request,
  received?: (started: AcpSessionStarted) => void
): Promise<AcpSessionStarted> {
  const setup = async (): Promise<AcpSessionStarted> => {
    const {
      sessionId,
      resumePreference,
      authMethodId: _auth,
      authMethodUnavailableMessage: _unavailable,
      ...params
    } = options
    if (sessionId === undefined) {
      const response = await request('session/new', params, newSessionSchema, (response) =>
        received?.({ kind: 'new', sessionId: response.sessionId, response })
      )
      return { kind: 'new', sessionId: response.sessionId, response }
    }
    const capabilities = initialized.agentCapabilities
    const load = capabilities?.loadSession === true
    const resume = capabilities?.sessionCapabilities?.resume != null
    if (load && (resumePreference !== 'resume' || !resume)) {
      return {
        kind: 'load',
        sessionId,
        response: await request(
          'session/load',
          { ...params, sessionId },
          loadSessionSchema,
          (response) => received?.({ kind: 'load', sessionId, response })
        )
      }
    }
    if (resume) {
      return {
        kind: 'resume',
        sessionId,
        response: await request(
          'session/resume',
          { ...params, sessionId },
          resumeSessionSchema,
          (response) => received?.({ kind: 'resume', sessionId, response })
        )
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
      if (initialized.authMethods && options.authMethodId && options.authMethodUnavailableMessage) {
        throw withProviderDiagnostic(
          new AcpRpcError(-32602, options.authMethodUnavailableMessage),
          providerDiagnostic(options.authMethodUnavailableMessage, 'person')
        )
      }
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
