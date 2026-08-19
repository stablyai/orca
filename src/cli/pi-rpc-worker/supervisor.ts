import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { rm } from 'node:fs/promises'
import type { ReadStream } from 'node:tty'
import { buildPiRpcWorkerModelPrompt } from '../../shared/pi-rpc-worker-launch'
import {
  buildPiChildEnvironment,
  buildPiExecutableInvocation,
  buildPiRpcArgv,
  resolvePiExecutable,
  type PiRpcLaunchOptions
} from './child-environment'
import { materializeLifecycleExtension } from './extension-cache'
import { StrictJsonlDecoder } from './jsonl-decoder'
import { PiWorkerLifecycle, type LifecycleAction } from './lifecycle'
import { parsePiRpcWorkerOptions } from './options'
import { readPrivateDispatchFromStdin } from './private-input'
import {
  PI_IDLE_TITLE,
  renderLifecycleAction,
  renderPiEvent,
  sanitizeForTerminal
} from './renderer'
import { PiWorkerRuntime } from './runtime'
import type { PiRpcWorkerDispatchEnvelope, RpcObject, RuntimeClientLike } from './types'

export { parsePiRpcWorkerOptions } from './options'

const STARTUP_HANDSHAKE_TIMEOUT_MS = 20_000
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1_000

function writeRpcCommand(child: ChildProcessWithoutNullStreams, command: RpcObject): Promise<void> {
  return new Promise((resolve, reject) => {
    child.stdin.write(`${JSON.stringify(command)}\n`, (error) => {
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    })
  })
}

type SupervisorDependencies = {
  createRuntimeClient: () => Promise<RuntimeClientLike>
  spawnPi?: typeof spawn
  resolvePi?: typeof resolvePiExecutable
  buildPiInvocation?: typeof buildPiExecutableInvocation
  materializeExtension?: typeof materializeLifecycleExtension
  cleanupExtension?: (path: string) => Promise<void>
}

async function defaultRuntimeClient(): Promise<RuntimeClientLike> {
  const { RuntimeClient } = await import('../runtime-client.js')
  return new RuntimeClient(undefined, undefined, null, null)
}

function redactPrivateValues(envelope: PiRpcWorkerDispatchEnvelope, value: string): string {
  let redacted = value
  for (const secret of [
    envelope.taskId,
    envelope.dispatchId,
    envelope.workerHandle,
    envelope.capability
  ]) {
    redacted = redacted.split(secret).join('[redacted]')
  }
  return redacted
}

async function reportSupervisorFailure(
  runtime: PiWorkerRuntime,
  secrets: string[],
  error: unknown
): Promise<never> {
  const message = sanitizeForTerminal(error instanceof Error ? error.message : '', secrets, 1_024)
  try {
    await runtime.escalate({
      subject: 'Pi RPC worker failed',
      body: message || 'The Pi RPC worker failed closed without a safe diagnostic.'
    })
  } catch {
    // Preserve the original supervisor failure when the runtime is unavailable.
  }
  throw new Error(message || 'The Pi RPC worker failed closed.')
}

async function cleanupLifecycleExtension(
  dependencies: SupervisorDependencies,
  path: string
): Promise<void> {
  const cleanup = dependencies.cleanupExtension ?? (async () => rm(path, { force: true }))
  await cleanup(path).catch(() => undefined)
}

export async function supervisePiRpcWorker(
  envelope: PiRpcWorkerDispatchEnvelope,
  options: PiRpcLaunchOptions = {},
  dependencies: SupervisorDependencies = { createRuntimeClient: defaultRuntimeClient }
): Promise<void> {
  const client = await dependencies.createRuntimeClient()
  const runtime = new PiWorkerRuntime(client, envelope)
  const secrets = [envelope.taskId, envelope.dispatchId, envelope.workerHandle, envelope.capability]
  const childEnvironment = buildPiChildEnvironment(process.env)
  let piExecutable: string
  try {
    piExecutable = (dependencies.resolvePi ?? resolvePiExecutable)(
      childEnvironment,
      process.platform,
      process.cwd()
    )
  } catch (error) {
    return await reportSupervisorFailure(runtime, secrets, error)
  }
  let piInvocation: ReturnType<typeof buildPiExecutableInvocation>
  try {
    piInvocation = (dependencies.buildPiInvocation ?? buildPiExecutableInvocation)(
      piExecutable,
      process.execPath,
      Boolean(process.versions.electron)
    )
  } catch (error) {
    return await reportSupervisorFailure(runtime, secrets, error)
  }
  const nonce = randomBytes(32).toString('hex')
  let extension: Awaited<ReturnType<typeof materializeLifecycleExtension>>
  try {
    extension = await (dependencies.materializeExtension ?? materializeLifecycleExtension)(nonce)
  } catch (error) {
    return await reportSupervisorFailure(runtime, secrets, error)
  }
  const lifecycle = new PiWorkerLifecycle(
    nonce,
    extension.selectedSource,
    extension.workspaceRuntime
  )
  let child: ChildProcessWithoutNullStreams
  try {
    child = (dependencies.spawnPi ?? spawn)(
      piInvocation.executable,
      [...piInvocation.argsPrefix, ...buildPiRpcArgv(extension.path, options)],
      {
        cwd: process.cwd(),
        env: { ...childEnvironment, ...piInvocation.env },
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      }
    )
  } catch (error) {
    await cleanupLifecycleExtension(dependencies, extension.path)
    return await reportSupervisorFailure(runtime, secrets, error)
  }
  let failure: Error | undefined
  let processing = Promise.resolve()
  let handshakeTimer: NodeJS.Timeout | undefined
  let heartbeatTimer: NodeJS.Timeout | undefined
  let killTimer: NodeJS.Timeout | undefined

  const fail = (error: unknown): void => {
    if (failure) {
      return
    }
    failure = error instanceof Error ? error : new Error('Pi RPC worker failed')
    child.kill()
    killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000)
    killTimer.unref()
  }
  const writeTerminal = (value: string): void => {
    const safe = sanitizeForTerminal(value, secrets, 16_384)
    if (!safe) {
      return
    }
    process.stdout.write(safe)
  }
  const handleAction = async (action: LifecycleAction): Promise<void> => {
    if (action.type === 'handshake') {
      if (handshakeTimer) {
        clearTimeout(handshakeTimer)
      }
      const promptId = `orca-prompt-${nonce}`
      lifecycle.markPromptSent(promptId)
      await writeRpcCommand(child, {
        id: promptId,
        type: 'prompt',
        message: buildPiRpcWorkerModelPrompt(redactPrivateValues(envelope, envelope.taskSpec))
      })
      return
    }
    const rendered = renderLifecycleAction(action, secrets)
    if (rendered) {
      writeTerminal(rendered)
    }
    if (action.type === 'ask') {
      const answer = await runtime.ask(action.input)
      const safeAnswer = sanitizeForTerminal(answer, secrets, 16_384)
      lifecycle.markUiResponseSent(action.requestId)
      await writeRpcCommand(child, {
        type: 'extension_ui_response',
        id: action.requestId,
        value: safeAnswer
      })
    } else if (action.type === 'progress') {
      await runtime.progress(action.input)
    } else if (action.type === 'escalation') {
      await runtime.escalate(action.input)
    }
  }
  const handleRecord = async (record: RpcObject): Promise<void> => {
    if (failure) {
      return
    }
    const actions = lifecycle.handle(record)
    const rendered = renderPiEvent(record, secrets)
    if (rendered.title) {
      process.stdout.write(rendered.title)
    }
    if (rendered.output) {
      writeTerminal(rendered.output)
    }
    for (const action of actions) {
      await handleAction(action)
    }
  }
  const decoder = new StrictJsonlDecoder((record) => {
    processing = processing.then(() => handleRecord(record)).catch(fail)
  })

  child.stdout.on('data', (chunk: Buffer) => {
    try {
      decoder.push(chunk)
    } catch (error) {
      fail(error)
    }
  })
  child.stderr.on('data', () => undefined)
  child.once('error', fail)
  handshakeTimer = setTimeout(
    () => fail(new Error('Pi lifecycle startup handshake timed out')),
    STARTUP_HANDSHAKE_TIMEOUT_MS
  )
  heartbeatTimer = setInterval(() => {
    void runtime.heartbeat().catch(fail)
  }, HEARTBEAT_INTERVAL_MS)
  heartbeatTimer.unref()

  const { code, signal } = await new Promise<{
    code: number | null
    signal: NodeJS.Signals | null
  }>((resolve) => child.once('close', (code, signal) => resolve({ code, signal })))
  if (handshakeTimer) {
    clearTimeout(handshakeTimer)
  }
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
  }
  if (killTimer) {
    clearTimeout(killTimer)
  }
  try {
    decoder.finish()
    await processing
    if (failure) {
      throw failure
    }
    const completion = lifecycle.assertCleanExit(code, signal)
    await runtime.workerDone(completion)
    process.stdout.write(PI_IDLE_TITLE)
  } catch (error) {
    return await reportSupervisorFailure(runtime, secrets, error)
  } finally {
    await cleanupLifecycleExtension(dependencies, extension.path)
  }
}

export async function runPiRpcWorker(
  argv: string[] = [],
  stdin: ReadStream = process.stdin
): Promise<void> {
  const options = parsePiRpcWorkerOptions(argv)
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    throw new Error('pi-rpc-worker requires an Orca worker PTY')
  }
  stdin.setRawMode(true)
  process.stdout.write(PI_IDLE_TITLE)
  try {
    const envelope = await readPrivateDispatchFromStdin(stdin)
    await supervisePiRpcWorker(envelope, options)
  } finally {
    stdin.setRawMode(false)
    stdin.pause()
  }
}
