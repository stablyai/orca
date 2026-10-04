import { CursorAcpPermissionCancellation } from './cursor-acp-permission-cancellation'
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

const initializeSchema = z
  .object({
    protocolVersion: z.literal(1),
    agentCapabilities: z
      .object({
        loadSession: z.boolean().optional(),
        promptCapabilities: z.object({ image: z.boolean().optional() }).passthrough().optional(),
        sessionCapabilities: z
          .object({ list: z.object({}).passthrough().optional() })
          .passthrough()
          .optional()
      })
      .passthrough()
  })
  .passthrough()

export type CursorAcpCapabilities = z.infer<typeof initializeSchema>['agentCapabilities']
export type CursorAcpConnection = CodexAppServerConnection & {
  readonly capabilities: CursorAcpCapabilities
  readonly permissionCancellation: CursorAcpPermissionCancellation
}
export type CursorAcpLaunch = CodexAppServerLaunch
export type CursorAcpHandlers = CodexAppServerConnectionHandlers

export class CursorAcpRequestError extends Error {
  readonly providerDiagnostic

  constructor(
    readonly method: string,
    readonly code: number | null,
    detail: string
  ) {
    super(`Cursor ACP ${method} failed: ${detail}`)
    this.name = 'CursorAcpRequestError'
    this.providerDiagnostic = providerDiagnostic(detail, 'person')
  }
}

export async function openCursorAcpConnection(
  launch: CursorAcpLaunch,
  handlers: CursorAcpHandlers = {},
  spawnImpl: typeof spawnProcess = spawnProcess
): Promise<CursorAcpConnection> {
  let capabilities: CursorAcpCapabilities = {}
  const connection = await openProviderStdioConnection(launch, handlers, spawnImpl, {
    name: 'Cursor ACP',
    jsonrpc: '2.0',
    maxLineBytes: NDJSON_MAX_LINE_BYTES,
    validateRecord: (record) => {
      const hasId =
        typeof record.id === 'string' ||
        (typeof record.id === 'number' && Number.isSafeInteger(record.id))
      if (typeof record.method === 'string' && record.method.length > 0) {
        return !('result' in record) && !('error' in record) && (!('id' in record) || hasId)
      }
      return hasId && 'result' in record !== 'error' in record
    },
    initialize: async (transport) => {
      const result = initializeSchema.safeParse(
        await transport.request(
          'initialize',
          {
            protocolVersion: 1,
            clientInfo: { name: 'orca', version: '1' },
            clientCapabilities: {}
          },
          { timeoutMs: 15_000 }
        )
      )
      if (!result.success) {
        throw new Error('Cursor ACP returned an unsupported initialization response')
      }
      capabilities = result.data.agentCapabilities
    },
    requestError: (method, error) =>
      new CursorAcpRequestError(
        method,
        typeof error.code === 'number' ? error.code : null,
        typeof error.message === 'string' ? error.message : 'Unknown provider error'
      ),
    exitError: (stderr, cause) =>
      cause ??
      withProviderDiagnostic(
        new Error('Cursor ACP connection ended'),
        providerDiagnostic(stderr.trim().slice(0, 400), 'log')
      )
  })
  return Object.assign(connection, {
    capabilities,
    permissionCancellation: new CursorAcpPermissionCancellation()
  })
}
