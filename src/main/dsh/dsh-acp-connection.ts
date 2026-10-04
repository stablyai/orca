import { z } from 'zod'
import { NDJSON_MAX_LINE_BYTES } from '../../shared/main-process-ndjson-framer'
import { providerDiagnostic, withProviderDiagnostic } from '../../shared/agent-session-failure'
import { spawnProcess } from '../../shared/child-process/run-process'
import {
  openProviderStdioConnection,
  type CodexAppServerLaunch,
  type CodexAppServerConnection,
  type CodexAppServerConnectionHandlers
} from '../codex/codex-app-server-connection'
import { DshAcpPermissionCancellation } from './dsh-acp-permission-cancellation'

const initializeSchema = z.object({
  protocolVersion: z.literal(1),
  agentInfo: z.object({ name: z.literal('deepseek-harness-acp'), version: z.string() }),
  agentCapabilities: z.object({
    sessionCapabilities: z.object({ close: z.object({}), list: z.object({}), resume: z.object({}) })
  })
})
export type DshAcpCapabilities = z.infer<typeof initializeSchema>['agentCapabilities']
export type DshAcpConnection = CodexAppServerConnection & {
  readonly capabilities: DshAcpCapabilities
  readonly permissionCancellation: DshAcpPermissionCancellation
}
export type DshAcpLaunch = CodexAppServerLaunch
export type DshAcpHandlers = CodexAppServerConnectionHandlers

export class DshAcpRequestError extends Error {
  readonly providerDiagnostic
  constructor(
    readonly method: string,
    readonly code: number | null,
    detail: string
  ) {
    super(`DeepSeek Harness ACP ${method} failed: ${detail}`)
    this.name = 'DshAcpRequestError'
    this.providerDiagnostic = providerDiagnostic(detail, 'person')
  }
}

export async function openDshAcpConnection(
  launch: DshAcpLaunch,
  handlers: DshAcpHandlers = {},
  spawnImpl: typeof spawnProcess = spawnProcess
): Promise<DshAcpConnection> {
  let capabilities: DshAcpCapabilities | undefined
  const connection = await openProviderStdioConnection(launch, handlers, spawnImpl, {
    name: 'DeepSeek Harness ACP',
    jsonrpc: '2.0',
    maxLineBytes: NDJSON_MAX_LINE_BYTES,
    validateRecord: (record) => {
      const hasId =
        typeof record.id === 'string' ||
        (typeof record.id === 'number' && Number.isSafeInteger(record.id))
      return typeof record.method === 'string' && record.method.length > 0
        ? !('result' in record) && !('error' in record) && (!('id' in record) || hasId)
        : hasId && 'result' in record !== 'error' in record
    },
    initialize: async (transport) => {
      capabilities = initializeSchema.parse(
        await transport.request(
          'initialize',
          {
            protocolVersion: 1,
            clientInfo: { name: 'orca', version: '1' },
            clientCapabilities: {}
          },
          { timeoutMs: 15_000 }
        )
      ).agentCapabilities
    },
    requestError: (method, error) =>
      new DshAcpRequestError(
        method,
        typeof error.code === 'number' ? error.code : null,
        typeof error.message === 'string' ? error.message : 'Unknown provider error'
      ),
    exitError: (stderr, cause) =>
      cause ??
      withProviderDiagnostic(
        new Error('DeepSeek Harness ACP connection ended'),
        providerDiagnostic(stderr.trim().slice(0, 400), 'log')
      )
  })
  if (!capabilities) {
    throw new Error('DeepSeek Harness ACP initialization did not complete')
  }
  return Object.assign(connection, {
    capabilities,
    permissionCancellation: new DshAcpPermissionCancellation()
  })
}
