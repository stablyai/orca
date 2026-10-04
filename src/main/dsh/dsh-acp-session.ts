import { z } from 'zod'
import { isAbsolute } from 'node:path'
import type { DshAcpConnection, DshAcpHandlers, DshAcpLaunch } from './dsh-acp-connection'
import { openDshAcpConnection } from './dsh-acp-connection'
import { CodexAcquisitionWindow } from '../codex/codex-structured-acquisition-window'

const sessionIdSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (id) =>
      id === id.trim() &&
      [...id].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
  )
const createdSchema = z.object({ sessionId: sessionIdSchema }).passthrough()
const updateSchema = z
  .object({
    sessionId: sessionIdSchema,
    update: z
      .object({
        sessionUpdate: z.string()
      })
      .passthrough()
  })
  .passthrough()
const promptResultSchema = z
  .object({
    stopReason: z.enum(['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled'])
  })
  .passthrough()

export type DshAcpUpdate = z.infer<typeof updateSchema>['update']
export type DshAcpStopReason = z.infer<typeof promptResultSchema>['stopReason']
export type DshAcpSessionPhase = 'ready' | 'prompting' | 'cancelling' | 'failed' | 'closed'
export type DshAcpSessionEvents = {
  ready?: (sessionId: string, connection: DshAcpConnection, state: unknown) => void
  update: (update: DshAcpUpdate, replay: boolean) => void
  request: NonNullable<DshAcpHandlers['onServerRequest']>
  notification?: NonNullable<DshAcpHandlers['onNotification']>
  exit?: NonNullable<DshAcpHandlers['onExit']>
}

export class DshAcpSession {
  private currentPhase: DshAcpSessionPhase = 'ready'
  private activePrompt: Promise<DshAcpStopReason> | null = null

  constructor(
    readonly sessionId: string,
    readonly connection: DshAcpConnection
  ) {}

  get phase(): DshAcpSessionPhase {
    return this.currentPhase
  }

  prompt(
    prompt: readonly Record<string, unknown>[],
    timeoutMs = 30 * 60_000
  ): Promise<DshAcpStopReason> {
    if (this.currentPhase !== 'ready' || this.connection.closed) {
      throw new Error('Dsh ACP session cannot take another prompt')
    }
    this.connection.permissionCancellation.beginTurn()
    this.currentPhase = 'prompting'
    const pending = this.connection
      .request(
        'session/prompt',
        {
          sessionId: this.sessionId,
          prompt
        },
        { timeoutMs }
      )
      .then((result) => {
        if (this.connection.closed) {
          throw new Error('Dsh ACP prompt ended after its transport became unusable')
        }
        const parsed = promptResultSchema.parse(result)
        if (this.currentPhase !== 'closed') {
          this.currentPhase = 'ready'
        }
        return parsed.stopReason
      })
      .catch((error: unknown) => {
        if (this.currentPhase !== 'closed') {
          this.currentPhase = 'failed'
        }
        void this.connection.close()
        throw error
      })
      .finally(() => {
        this.connection.permissionCancellation.cancel()
        if (this.activePrompt === pending) {
          this.activePrompt = null
        }
      })
    this.activePrompt = pending
    return pending
  }

  async cancel(timeoutMs = 5_000): Promise<boolean> {
    const pending = this.activePrompt
    if (!pending || this.connection.closed || this.currentPhase === 'closed') {
      return false
    }
    if (this.currentPhase === 'prompting') {
      this.currentPhase = 'cancelling'
      this.connection.notify('session/cancel', { sessionId: this.sessionId })
      this.connection.permissionCancellation.cancel()
    }
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      return (
        (await Promise.race([
          pending,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error('Dsh ACP did not confirm cancellation')),
              timeoutMs
            )
          })
        ])) === 'cancelled'
      )
    } finally {
      clearTimeout(timeout)
    }
  }

  async close(): Promise<boolean> {
    this.currentPhase = 'closed'
    this.connection.permissionCancellation.cancel()
    try {
      if (!this.connection.closed) {
        await this.connection.request(
          'session/close',
          { sessionId: this.sessionId },
          { timeoutMs: 5_000 }
        )
      }
    } catch {
      // Physical exit remains required when the protocol close fails.
    }
    return this.connection.close()
  }
}

export async function createDshAcpSession(input: {
  launch: DshAcpLaunch
  cwd: string
  sessionId?: string
  events: DshAcpSessionEvents
  onSpawned?: DshAcpHandlers['onSpawned']
  openConnection?: typeof openDshAcpConnection
}): Promise<DshAcpSession> {
  if (!isAbsolute(input.cwd)) {
    throw new Error('Dsh ACP requires an execution-host absolute cwd')
  }
  const restoredId =
    input.sessionId === undefined ? undefined : sessionIdSchema.parse(input.sessionId)
  const window = new CodexAcquisitionWindow()
  let connection: DshAcpConnection | null = null
  let sessionId = restoredId ?? ''
  let state: unknown = {}
  let failure: Error | null = null
  const fail = (error: Error): void => {
    failure ??= error
    void connection?.close()
  }
  const deliver = (operation: () => void, payload: unknown): void => {
    if (failure) {
      return
    }
    const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8')
    if (window.buffer(operation, bytes)) {
      return
    }
    if (window.isOverflowed) {
      fail(new Error('Dsh ACP startup history exceeded its bounded buffer'))
      return
    }
    try {
      operation()
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)))
    }
  }
  connection = await (input.openConnection ?? openDshAcpConnection)(input.launch, {
    ...(input.onSpawned ? { onSpawned: input.onSpawned } : {}),
    onNotification: (method, params) => {
      deliver(() => {
        if (method === 'session/update') {
          const parsed = updateSchema.safeParse(params)
          if (!parsed.success || parsed.data.sessionId !== sessionId) {
            fail(new Error('Dsh ACP update did not match the owned session'))
            return
          }
          input.events.update(parsed.data.update, false)
        } else {
          input.events.notification?.(method, params)
        }
      }, params)
    },
    onServerRequest: (request) => {
      deliver(() => input.events.request(request), request)
    },
    onUnhandledFrame: () => fail(new Error('Dsh ACP emitted an unclassified record')),
    onExit: (error) => {
      failure ??= error
      input.events.exit?.(error)
    }
  })
  window.connection = connection
  try {
    if (failure) {
      throw failure
    }
    if (restoredId !== undefined) {
      if (!connection.capabilities.sessionCapabilities.resume) {
        throw new Error('Dsh ACP does not support resuming this session')
      }
      state = await connection.request('session/resume', {
        sessionId: restoredId,
        cwd: input.cwd,
        mcpServers: []
      })
    } else {
      const created = createdSchema.parse(
        await connection.request('session/new', { cwd: input.cwd, mcpServers: [] })
      )
      sessionId = created.sessionId
      state = created
    }
    input.events.ready?.(sessionId, connection, state)
    for (const operation of window.drain()) {
      operation()
    }
    if (failure || window.isOverflowed) {
      throw failure ?? new Error('Dsh ACP startup history exceeded its bounded buffer')
    }
    return new DshAcpSession(sessionId, connection)
  } catch (error) {
    window.drain()
    if (!(await connection.close())) {
      throw new Error('Dsh ACP acquisition failed without process-exit proof', { cause: error })
    }
    throw error
  }
}
