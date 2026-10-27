import { z } from 'zod'
import { normalizeExecutionHostId, parseExecutionHostId } from '../../shared/execution-host'
import { toRemoteRuntimePtyId } from '../../shared/remote-runtime/remote-runtime-pty-id'
import type { TerminalCreateParams } from '../../shared/rpc-contract/terminal-unary-params'
import type { RuntimeTerminalCreate } from '../../shared/runtime-types'
import { isTerminalCreatedHere } from '../../shared/runtime-terminal-contracts'
import type { OrchestrationEnvironmentTransport } from './orchestration/environment-transport'

export type TerminalHostCreateParams = z.infer<typeof TerminalCreateParams>
export type TerminalHostCreateDependencies = {
  resolveWorkspace: (
    selector: string
  ) => Promise<{ managedWorktree: { projectId?: string } | null }>
  transport: OrchestrationEnvironmentTransport | null
  /** Binds the created owner terminal locally; false closes it at the owner and fails the create. */
  bind?: (created: RuntimeTerminalCreate) => Promise<boolean>
}

const SetupList = z.object({
  setups: z.array(
    z.object({
      id: z.string(),
      projectId: z.string(),
      hostId: z.string(),
      path: z.string(),
      setupState: z.string(),
      executionHostId: z.string().nullish(),
      connectionId: z.string().nullish()
    })
  )
})
const CreatedTerminal = z.object({
  handle: z.string().min(1),
  worktreeId: z.string().min(1),
  title: z.string().nullable(),
  tabId: z.string().optional(),
  paneKey: z.string().nullish(),
  incarnationId: z.string().nullish(),
  hostPlatform: z
    .enum([
      'aix',
      'android',
      'darwin',
      'freebsd',
      'haiku',
      'linux',
      'openbsd',
      'sunos',
      'win32',
      'cygwin',
      'netbsd'
    ])
    .optional(),
  surface: z.enum(['background', 'visible']).optional(),
  warning: z.string().optional(),
  agentSessionDisposition: z.enum(['created', 'adopted']).optional(),
  isReattach: z.literal(true).optional()
})
const RecoverableTerminal = CreatedTerminal.pick({
  handle: true,
  incarnationId: true,
  agentSessionDisposition: true,
  isReattach: true
})

export class TerminalHostCreateError extends Error {
  constructor(
    readonly code:
      | 'project_not_set_up_on_host'
      | 'host_kind_not_supported_yet'
      | 'invalid_runtime_response'
      | 'local_binding_refused',
    readonly data: {
      executionHostId?: string
      projectHostSetupId?: string
      projectId?: string
      terminal?: z.infer<typeof RecoverableTerminal>
    }
  ) {
    super(code)
  }
}

export async function forwardTerminalCreate(
  params: TerminalHostCreateParams,
  { resolveWorkspace, transport, bind }: TerminalHostCreateDependencies
): Promise<RuntimeTerminalCreate> {
  const host = parseExecutionHostId(params.executionHostId)
  const data = {
    executionHostId: params.executionHostId,
    projectHostSetupId: params.projectHostSetupId
  }
  if (host?.kind !== 'runtime' || !transport) {
    throw new TerminalHostCreateError('host_kind_not_supported_yet', data)
  }
  let server: ReturnType<OrchestrationEnvironmentTransport['resolve']>
  try {
    server = transport.resolve(host.environmentId)
  } catch {
    throw new TerminalHostCreateError('host_kind_not_supported_yet', data)
  }
  if (server.environmentId !== host.environmentId) {
    throw new TerminalHostCreateError('host_kind_not_supported_yet', data)
  }
  const projectId = params.worktree
    ? (await resolveWorkspace(params.worktree)).managedWorktree?.projectId
    : undefined
  const refuseSetup = () =>
    new TerminalHostCreateError('project_not_set_up_on_host', { ...data, projectId })
  if (!projectId || !params.projectHostSetupId) {
    throw refuseSetup()
  }
  const call = async (method: string, payload: unknown): Promise<unknown> => {
    const response = await transport.call(
      server.environmentId,
      method,
      payload,
      15_000,
      undefined,
      server.pairingRevision
    )
    if (!response.ok) {
      throw Object.assign(new Error(response.error.message), response.error)
    }
    return response.result
  }
  const catalog = SetupList.safeParse(await call('projectHostSetup.list', undefined))
  if (!catalog.success) {
    throw new TerminalHostCreateError('invalid_runtime_response', { ...data, projectId })
  }
  const ownsHost = (id: string) => {
    const normalized = normalizeExecutionHostId(id)
    return normalized === 'local' || normalized === host.id
  }
  const setup = catalog.data.setups.find(
    (candidate) =>
      candidate.id === params.projectHostSetupId &&
      candidate.projectId === projectId &&
      candidate.setupState === 'ready' &&
      candidate.path.trim() !== '' &&
      ownsHost(candidate.hostId) &&
      !candidate.connectionId &&
      (candidate.executionHostId == null || ownsHost(candidate.executionHostId))
  )
  if (!setup) {
    throw refuseSetup()
  }
  const createReply = await call('terminal.create', {
    worktree: `path:${setup.path}`,
    command: params.command,
    startupCommandDelivery: params.startupCommandDelivery,
    env: params.env,
    envToDelete: params.envToDelete,
    launchConfig: params.launchConfig,
    resumeProviderSession: params.resumeProviderSession,
    launchToken: params.launchToken,
    launchAgent: params.launchAgent,
    terminalKittyKeyboardProtocol: params.terminalKittyKeyboardProtocol,
    terminalColorQueryReplies: params.terminalColorQueryReplies,
    shell: params.shell,
    title: params.title,
    focus: false,
    activate: false,
    presentation: 'background'
  })
  const created = z.object({ terminal: CreatedTerminal }).safeParse(createReply)
  if (!created.success) {
    const recoverable = z.object({ terminal: RecoverableTerminal }).safeParse(createReply)
    const terminal = recoverable.success ? recoverable.data.terminal : undefined
    if (terminal && isTerminalCreatedHere(terminal)) {
      try {
        await call('terminal.close', {
          terminal: terminal.handle,
          // Legacy close handlers ignore this field; enforcement is deferred.
          ...(terminal.incarnationId ? { expectedIncarnationId: terminal.incarnationId } : {})
        })
      } catch {
        // Cleanup cannot replace the original protocol fault.
      }
    }
    throw new TerminalHostCreateError('invalid_runtime_response', { ...data, projectId, terminal })
  }
  const terminal = created.data.terminal
  const result = {
    ...terminal,
    executionHostId: host.id,
    ptyId: toRemoteRuntimePtyId(terminal.handle, server.environmentId)
  }
  const bound = await bind?.(result).catch((error: unknown) => ({ error }))
  if (bind && bound !== true) {
    if (isTerminalCreatedHere(terminal)) {
      const incarnation = terminal.incarnationId
        ? { expectedIncarnationId: terminal.incarnationId }
        : {}
      await call('terminal.close', { terminal: terminal.handle, ...incarnation }).catch(() => {})
    }
    throw typeof bound === 'object'
      ? bound.error
      : new TerminalHostCreateError('local_binding_refused', { ...data, projectId })
  }
  return result
}
