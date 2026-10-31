import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { ProviderAcquisitionStarts } from '../provider-process/provider-acquisition-starts'
import { removeAntigravitySignInSessionFiles } from '../antigravity/antigravity-sign-in-session-files'
import { SOURCE_CONTROL_GENERATION_TIMEOUT_MS } from '../text-generation/source-control-generation-limits'
import { STRUCTURED_CHILD_ENV_TO_DELETE } from '../runtime/structured-session-child-env'
import { resolveAcpLaunchInvocation } from './acp-structured-launch-resolution'
import { prepareAcpLaunch } from './acp-structured-launch-preparation'
import { acpPrivateTempConnect } from './acp-private-temp'
import { AcpRpcError } from './acp-errors'
import type { AcpStructuredConnection } from './acp-structured-connection'
import type { AcpStructuredSessionAdapterDeps } from './acp-structured-session-adapter-deps'

type TextInput = Parameters<NonNullable<StructuredAgentSessionAdapter['generateText']>>[0]
const envelope = z.looseObject({ sessionId: z.string() })
const TASK_ENV_TO_DELETE = [
  ...STRUCTURED_CHILD_ENV_TO_DELETE,
  'ORCA_AGENT_SESSION_ID',
  'ORCA_AGENT_SESSION_SPAWN_TOKEN',
  'ORCA_TERMINAL_HANDLE',
  'ORCA_STRUCTURED_SESSION',
  'ORCA_CHAT_SCRATCH_DIR',
  'ORCA_CHAT_VISUALS_DIR'
]

/** Disposable native tasks belong to the adapter so shutdown also owns uncertain closes. */
export class AcpTextTasks {
  private readonly children = new ProviderAcquisitionStarts<AcpStructuredConnection>()
  private readonly shutdown = new AbortController()
  private readonly pending = new Set<Promise<string | null>>()

  constructor(
    private readonly deps: Pick<
      AcpStructuredSessionAdapterDeps,
      'spec' | 'textTaskLaunch' | 'connect' | 'dataDirectory' | 'logger'
    >
  ) {}

  generate = async (input: TextInput): Promise<string | null> => {
    const gate = this.deps.spec.launchGate?.enter(this.shutdown.signal)
    let rootExited = Promise.resolve()
    const task = this.run(input, gate?.signal ?? this.shutdown.signal, (connection) => {
      rootExited = new Promise((resolve) => connection.onExit(() => resolve()))
    })
    this.pending.add(task)
    const finalized = task.finally(() => {
      this.pending.delete(task)
      gate?.leave()
    })
    return input.shouldExecute ? finalized.finally(() => rootExited) : finalized
  }

  async closeAll(): Promise<boolean> {
    this.shutdown.abort()
    await Promise.allSettled(this.pending)
    return (
      await Promise.all(this.children.failedSessionIds().map((id) => this.children.stopFailed(id)))
    ).every(Boolean)
  }

  private async run(
    input: TextInput,
    parent: AbortSignal,
    observeRoot: (connection: AcpStructuredConnection) => void
  ): Promise<string | null> {
    const { spec } = this.deps
    const deadline = new AbortController()
    const timer = setTimeout(
      () => deadline.abort(new Error('Chat naming timed out')),
      SOURCE_CONTROL_GENERATION_TIMEOUT_MS
    )
    const signal = AbortSignal.any([parent, deadline.signal])
    const stale = Symbol('stale naming task')
    const checkCurrent = (): void => {
      signal.throwIfAborted()
      if (input.shouldExecute?.() === false) {
        throw stale
      }
    }
    let connection: AcpStructuredConnection | undefined
    let cwd: string | undefined
    let home = ''
    let sessionId = ''
    let completed = false
    let starting = false
    let done = false
    let disposed = false
    let unsubscribe = (): void => {}
    const dispose = async (): Promise<void> => {
      if (starting || !done || disposed || !cwd || (connection && !connection.exited)) {
        return
      }
      disposed = true
      try {
        if (spec.agent === 'antigravity') {
          await removeAntigravitySignInSessionFiles(home, sessionId, cwd)
        }
        await rm(cwd, { recursive: true, force: true })
      } catch (error) {
        this.deps.logger?.warn('Naming helper files could not be removed', {
          scope: 'acp-text-task',
          error
        })
      }
    }
    try {
      signal.throwIfAborted()
      const invocation = this.deps.textTaskLaunch
      if (!invocation) {
        throw new Error('Native text task launch is unavailable')
      }
      const launch = await waitForPromiseWithSignal(
        prepareAcpLaunch(
          this.deps,
          () => resolveAcpLaunchInvocation(spec, input.accountHome, invocation),
          () => signal.throwIfAborted()
        ),
        signal
      )
      home = launch.env.GEMINI_HOME ?? ''
      cwd = await mkdtemp(join(tmpdir(), 'orca-chat-name-'))
      signal.throwIfAborted()
      const failed = new AbortController()
      const taskSignal = AbortSignal.any([signal, failed.signal])
      const reject = (): never => {
        const error = new AcpRpcError(
          -32601,
          'Tools and user input are unavailable during chat naming'
        )
        failed.abort(error)
        throw error
      }
      const promptId = randomUUID()
      const terminal = Promise.withResolvers<{ stopReason: string }>()
      const notification = (method: string, params: unknown): void => {
        if (!sessionId || envelope.safeParse(params).data?.sessionId !== sessionId) {
          return
        }
        const completion = spec.dialect.textTaskCompletion?.(method, params)
        if (completion?.promptId === promptId) {
          terminal.resolve(completion)
        }
        const mapped = spec.dialect.notification?.(method, params, Date.now())
        if (
          mapped?.disposition === 'map' &&
          mapped.turn === promptId &&
          !mapped.replay &&
          mapped.end
        ) {
          terminal.resolve(mapped.end)
        }
      }
      const spawn = (connect: typeof this.deps.connect): AcpStructuredConnection => {
        connection = connect(
          {
            ...launch,
            cwd,
            args: spec.args({ fullAccess: false, pluginDir: null }),
            envToDelete: [...launch.envToDelete, ...TASK_ENV_TO_DELETE]
          },
          {
            clientInfo: { name: 'orca-chat-naming', version: '1' },
            signIn: spec.signIn,
            onPermission: reject,
            onRequest: reject,
            onExtensionNotification: notification
          }
        )
        observeRoot(connection)
        this.children.retainFailed(promptId, connection)
        spec.launchGate?.retain(connection)
        connection.onExit(() => {
          void dispose()
        })
        return connection
      }
      const server = await waitForPromiseWithSignal(
        spec.privateTempDirectory
          ? acpPrivateTempConnect(this.deps, checkCurrent).then(spawn)
          : Promise.resolve().then(() => {
              checkCurrent()
              return spawn(this.deps.connect)
            }),
        signal
      )
      let output = ''
      unsubscribe = server.subscribe((event) => {
        const params = event.kind === 'known' ? event.notification : event.raw
        notification('session/update', params)
        if (params.sessionId !== sessionId) {
          return
        }
        const update = params.update
        if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
          failed.abort(new Error('The naming agent attempted tool work'))
        }
        if (
          event.kind === 'known' &&
          event.notification.update.sessionUpdate === 'agent_message_chunk'
        ) {
          const content = event.notification.update.content
          if (content.type === 'text') {
            if (output.length + content.text.length > 128_000) {
              failed.abort(new Error('Chat name output exceeded its limit'))
            } else {
              output += content.text
            }
          }
        }
      })
      const initialized = await waitForPromiseWithSignal(server.initialize(), taskSignal)
      const authMethodId = spec.authMethod?.({
        advertised: initialized.authMethods?.map((method) => method.id) ?? [],
        env: launch.env
      })
      starting = true
      await waitForPromiseWithSignal(
        server
          .start({ cwd, mcpServers: [], authMethodId })
          .then((started) => {
            sessionId = started.sessionId
          })
          .finally(() => {
            starting = false
            void dispose()
          }),
        taskSignal
      )
      const response = await waitForPromiseWithSignal(
        Promise.race([
          server.prompt([{ type: 'text', text: input.prompt }], { promptId, requestId: promptId }),
          terminal.promise
        ]),
        taskSignal
      )
      taskSignal.throwIfAborted()
      if (['cancelled', 'error', 'rate_limit'].includes(response.stopReason)) {
        throw new Error('The naming agent did not complete its reply')
      }
      completed = true
      return output
    } catch (error) {
      if (error === stale) {
        return null
      }
      throw error
    } finally {
      clearTimeout(timer)
      unsubscribe()
      deadline.abort()
      const cleanup = async (work: () => Promise<unknown>): Promise<void> => {
        try {
          await waitForPromiseWithSignal(work(), AbortSignal.timeout(2_000))
        } catch (error) {
          this.deps.logger?.warn('Naming helper protocol cleanup failed', {
            scope: 'acp-text-task',
            error
          })
        }
      }
      if (connection && sessionId) {
        const server = connection
        if (!completed) {
          await cleanup(() => server.cancel())
        }
        if (spec.agent === 'grok') {
          await cleanup(() =>
            server.requestExtension('_x.ai/session/delete', { sessionId, cwd }, 2_000)
          )
        }
      }
      if (connection && !(await connection.close().catch(() => false))) {
        this.deps.logger?.warn('Naming helper exit is unproven; retained for cleanup', {
          scope: 'acp-text-task'
        })
      }
      done = true
      await dispose()
    }
  }
}
