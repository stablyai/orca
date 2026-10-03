import type { z } from 'zod'
import { AcpAuthRequiredError, AcpRpcError } from './acp-errors'
import {
  NewSessionResponseSchema,
  LoadSessionResponseSchema,
  ResumeSessionResponseSchema,
  AuthenticateResponseSchema,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type LoadSessionResponse,
  type ResumeSessionResponse
} from './generated/protocol.gen'

export type AcpSessionStarted =
  | { kind: 'new'; sessionId: string; response: NewSessionResponse }
  | { kind: 'load'; sessionId: string; response: LoadSessionResponse }
  | { kind: 'resume'; sessionId: string; response: ResumeSessionResponse }
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
      const response = await request('session/new', params, NewSessionResponseSchema)
      return { kind: 'new', sessionId: response.sessionId, response }
    }
    const capabilities = initialized.agentCapabilities
    const load = capabilities?.loadSession === true
    const resume = capabilities?.sessionCapabilities?.resume != null
    if (load && (resumePreference !== 'resume' || !resume)) {
      return {
        kind: 'load',
        sessionId,
        response: await request('session/load', { ...params, sessionId }, LoadSessionResponseSchema)
      }
    }
    if (resume) {
      return {
        kind: 'resume',
        sessionId,
        response: await request(
          'session/resume',
          { ...params, sessionId },
          ResumeSessionResponseSchema
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
    const method = initialized.authMethods?.find((method) =>
      options.authMethodId ? method.id === options.authMethodId : method.type !== 'terminal'
    )
    if (!method || method.type === 'terminal') {
      throw error
    }
    await request('authenticate', { methodId: method.id }, AuthenticateResponseSchema)
    return setup()
  }
}
