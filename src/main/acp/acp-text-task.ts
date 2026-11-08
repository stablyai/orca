import { conversationNameTaskPrompt } from '../../shared/source-control/ai/generation/conversation-name-generation'
import { randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import { ProviderAcquisitionStarts } from '../provider-process/provider-acquisition-starts'
import { removeAntigravitySignInSessionFiles } from '../antigravity/antigravity-sign-in-session-files'
import { SOURCE_CONTROL_GENERATION_TIMEOUT_MS } from '../text-generation/source-control-generation-limits'
import { resolveAcpLaunchInvocation } from './acp-structured-launch-resolution'
import { acpLaunchSpecForAccount } from './acp-launch-command'
import { prepareAcpLaunch } from './acp-structured-launch-preparation'
import { acpPrivateTempConnect } from './acp-private-temp'
import {
  acpTextTaskCompletion,
  acpTextTaskArgs,
  acpTextTaskEnv,
  cleanupAcpTextTaskProtocol,
  cleanupGrokTextTaskSession,
  denyAcpTextTaskPermission,
  rejectAcpTextTaskWork,
  TASK_ENV_TO_DELETE
} from './acp-text-task-policy'
import type { AcpStructuredConnection } from './acp-structured-connection'
import type { AcpStructuredSessionAdapterDeps } from './acp-structured-session-adapter-deps'
import { grokTextTaskPreservesAccount, runGrokTextTask } from '../grok/grok-text-task'

type TextInput = Parameters<NonNullable<StructuredAgentSessionAdapter['generateText']>>[0]

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
    const namingPrompt = conversationNameTaskPrompt(input.prompt)
    const deadlineAt = Date.now() + SOURCE_CONTROL_GENERATION_TIMEOUT_MS
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
    let modeConfigId = 'mode'
    let completed = false
    let headless = false
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
      // A naming session would stay in the user's own agent history.
      if (acpLaunchSpecForAccount(spec, input.accountHome).keepsEverySession) {
        return null
      }
      const launch = await waitForPromiseWithSignal(
        prepareAcpLaunch(
          () => resolveAcpLaunchInvocation(spec, input.accountHome, invocation),
          () => signal.throwIfAborted()
        ),
        signal
      )
      home = launch.env.GEMINI_HOME ?? ''
      cwd = await mkdtemp(join(tmpdir(), 'orca-chat-name-'))
      if (spec.agent === 'grok') {
        cwd = await realpath(cwd)
      }
      checkCurrent()
      const failed = new AbortController()
      const taskSignal = AbortSignal.any([signal, failed.signal])
      const reject = (): never => rejectAcpTextTaskWork(failed)
      const promptId = randomUUID()
      const terminal = Promise.withResolvers<{ stopReason: string }>()
      const notification = (method: string, params: unknown): void => {
        const completion = acpTextTaskCompletion(spec.dialect, sessionId, promptId, method, params)
        if (completion) {
          terminal.resolve(completion)
        }
      }
      const spawn = (connect: typeof this.deps.connect): AcpStructuredConnection => {
        connection = connect(
          {
            ...launch,
            env: acpTextTaskEnv(spec.agent, launch.env),
            cwd,
            args: acpTextTaskArgs(spec),
            envToDelete: [...launch.envToDelete, ...TASK_ENV_TO_DELETE]
          },
          {
            clientInfo: { name: 'orca-chat-naming', version: '1' },
            signIn: spec.signIn,
            onPermission: (request) =>
              spec.agent === 'antigravity' ? denyAcpTextTaskPermission(request) : reject(),
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
        env: launch.env,
        antigravityChatAuth: launch.antigravityChatAuth
      })
      if (spec.agent === 'grok' && grokTextTaskPreservesAccount(initialized, authMethodId)) {
        headless = true
        sessionId = promptId
        if (authMethodId) {
          await waitForPromiseWithSignal(server.authenticate(authMethodId), taskSignal)
        }
        checkCurrent()
        return await runGrokTextTask({
          launch: {
            ...launch,
            args: [],
            env: acpTextTaskEnv(spec.agent, launch.env),
            envToDelete: [...launch.envToDelete, ...TASK_ENV_TO_DELETE]
          },
          cwd,
          prompt: namingPrompt,
          sessionId,
          signal: taskSignal,
          timeoutMs: Math.max(1, deadlineAt - Date.now())
        })
      }
      starting = true
      await waitForPromiseWithSignal(
        server
          .start({
            cwd,
            mcpServers: [],
            authMethodId,
            authMethodUnavailableMessage: spec.authMethodUnavailableMessage,
            ...(spec.agent === 'grok' ? { _meta: { yoloMode: false, autoMode: false } } : {})
          })
          .then((started) => {
            sessionId = started.sessionId
            modeConfigId =
              started.response.configOptions?.find(
                (option) => option.category === 'mode' && option.type === 'select'
              )?.id ?? 'mode'
          })
          .finally(() => {
            starting = false
            void dispose()
          }),
        taskSignal
      )
      if (spec.permissionModeConfig) {
        await waitForPromiseWithSignal(
          server.setConfigOption(modeConfigId, spec.permissionModeConfig.values.ask),
          taskSignal
        )
      }
      checkCurrent()
      const response = await waitForPromiseWithSignal(
        Promise.race([
          server.prompt([{ type: 'text', text: namingPrompt }], { promptId, requestId: promptId }),
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
      if (connection && sessionId) {
        const server = connection
        if (!completed && !headless) {
          await cleanupAcpTextTaskProtocol(() => server.cancel(), this.deps.logger)
        }
        if (spec.agent === 'grok') {
          await cleanupGrokTextTaskSession(server, sessionId, cwd, this.deps.logger)
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
