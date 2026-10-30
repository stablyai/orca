import { callAcpSession } from './acp-response-settlement'
import type { AcpJsonRpcPeer } from './acp-json-rpc-peer'
import type { AcpSessionResponse } from './acp-response-settlement'
import type { z } from 'zod'
import { AcpAuthRequiredError, AcpRpcError, acpAuthRequiredError } from './acp-errors'
import {
  ACP_PROTOCOL_VERSION,
  InitializeResponseSchema,
  type InitializeRequest,
  NewSessionResponseSchema,
  LoadSessionResponseSchema,
  ResumeSessionResponseSchema,
  AuthenticateResponseSchema,
  SessionModelStateSchema,
  type InitializeResponse,
  type NewSessionRequest,
  type SetSessionConfigOptionRequest
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
type Request = <T>(
  method: string,
  params: unknown,
  schema: z.ZodType<T>,
  received?: (response: AcpSessionResponse<T>) => void
) => Promise<T>

export async function setupAcpSession(
  initialized: InitializeResponse,
  options: AcpSessionStartOptions,
  request: Request,
  received?: (started: AcpSessionStarted) => void
): Promise<AcpSessionStarted> {
  const setup = async (): Promise<AcpSessionStarted> => {
    const { sessionId, resumePreference, authMethodId: _auth, ...params } = options
    if (sessionId === undefined) {
      const response = await request('session/new', params, newSessionSchema, (reply) => {
        if ('value' in reply) {
          received?.({ kind: 'new', sessionId: reply.value.sessionId, response: reply.value })
        }
      })
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
          (reply) => {
            if ('value' in reply) {
              received?.({ kind: 'load', sessionId, response: reply.value })
            }
          }
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
          (reply) => {
            if ('value' in reply) {
              received?.({ kind: 'resume', sessionId, response: reply.value })
            }
          }
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

export function initializeAcpSession(
  peer: AcpJsonRpcPeer,
  clientInfo: InitializeRequest['clientInfo'],
  answered: ((signedIn: boolean) => void) | undefined
): Promise<InitializeResponse> {
  return callAcpSession(
    peer,
    'initialize',
    {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      ...(clientInfo === undefined ? {} : { clientInfo })
    } satisfies InitializeRequest,
    InitializeResponseSchema,
    answered,
    (reply) => {
      if ('value' in reply && reply.value.protocolVersion !== ACP_PROTOCOL_VERSION) {
        const error = new AcpRpcError(
          -32602,
          `Unsupported ACP protocol version: ${reply.value.protocolVersion}`
        )
        peer.close(error)
        throw error
      }
    }
  )
}

export function acpSessionConfigRequest(
  sessionId: string,
  configId: SetSessionConfigOptionRequest['configId'],
  value: SetSessionConfigOptionRequest['value'],
  meta: SetSessionConfigOptionRequest['_meta']
): SetSessionConfigOptionRequest {
  return typeof value === 'boolean'
    ? ({
        configId,
        value,
        sessionId,
        type: 'boolean',
        ...(meta ? { _meta: meta } : {})
      } satisfies SetSessionConfigOptionRequest)
    : ({
        configId,
        value,
        sessionId,
        ...(meta ? { _meta: meta } : {})
      } satisfies SetSessionConfigOptionRequest)
}
