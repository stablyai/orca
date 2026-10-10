import { randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { spawnProcess } from '@orca/process-host'
import {
  forceTerminateProcessTree,
  signalProcessTree
} from '@orca/process-host/process-tree-termination'
import { withTimeout } from '../../shared/promise-timeout-fallback'
import { createOutputSink } from '@orca/process-host/bounded-output-sink'
import { readFetchResponseJsonWithinLimit } from '../../shared/fetch-response-body'
import { cancelUnreadResponseBody } from '../lib/unread-response-body'
import type { ChildProcessHandle } from '@orca/process-host/process-spec'
import { createProviderSpawnSpec } from '../provider-process/provider-process-supervisor'
import { stopSupervisedChildProcess } from '../provider-process/supervised-child-process-stop'

const OPENCODE_PREFLIGHT_KILL_SITE = 'opencode-launch-model-preflight'
// A supervisor's pipes are its own, so they close as it exits.
const SUPERVISOR_PIPE_CLOSE_MS = 1_000

const model = z.object({ id: z.string(), providerID: z.string() })
const availableModel = model.extend({ enabled: z.boolean() })
const agent = z.object({
  id: z.string(),
  mode: z.enum(['primary', 'subagent', 'all']),
  hidden: z.boolean(),
  model: model.optional()
})
const location = z.object({ directory: z.string() })
const modelResponse = z.object({ location, data: availableModel.array() })
const agentResponse = z.object({ location, data: agent.array() })
const defaultModelResponse = z.object({ location, data: availableModel.nullable() })
const configResponse = z.array(
  z.object({
    type: z.enum(['directory', 'document']),
    info: z.object({ default_agent: z.string().optional() }).optional()
  })
)

export type OpenCodeLaunchModelContext = {
  primaryAgent: string
  availableModels: string[]
  primaryModel: string | null
}

export function parseOpenCodeLaunchModelContext(options: {
  directory: string
  models: unknown
  agents: unknown
  defaultModel: unknown
  config: unknown
}): OpenCodeLaunchModelContext | null {
  const models = modelResponse.safeParse(options.models)
  const agents = agentResponse.safeParse(options.agents)
  const defaultModel = defaultModelResponse.safeParse(options.defaultModel)
  const config = configResponse.safeParse(options.config)
  if (
    !models.success ||
    !agents.success ||
    !defaultModel.success ||
    !config.success ||
    models.data.location.directory !== options.directory ||
    agents.data.location.directory !== options.directory ||
    defaultModel.data.location.directory !== options.directory ||
    !defaultModel.data.data?.enabled ||
    agents.data.data.length === 0
  ) {
    return null
  }
  // Installed 2.0.16 returns the selected default first; newer source has a different order.
  const primary = agents.data.data.find((item) => item.mode !== 'subagent' && !item.hidden)
  const configured = config.data.reduce<string | undefined>(
    (value, entry) => entry.info?.default_agent ?? value,
    undefined
  )
  const available = models.data.data.filter((item) => item.enabled)
  if (
    !primary ||
    (configured !== undefined && primary.id !== configured) ||
    !available.some(
      (item) =>
        item.id === defaultModel.data.data?.id &&
        item.providerID === defaultModel.data.data?.providerID
    )
  ) {
    return null
  }
  return {
    primaryAgent: primary.id,
    availableModels: available.map((item) => `${item.providerID}/${item.id}`),
    primaryModel: primary.model ? `${primary.model.providerID}/${primary.model.id}` : null
  }
}

export async function probeOpenCodeLaunchModelContext(options: {
  executable: string
  cwd: string
  env: NodeJS.ProcessEnv
  signal?: AbortSignal
  expectedPrimaryAgent?: string
  expectedPrimaryModel?: string
}): Promise<OpenCodeLaunchModelContext | null> {
  const password = randomBytes(32).toString('base64url')
  const spawnSpec = createProviderSpawnSpec(
    {
      command: options.executable,
      args: ['serve', '--hostname', '127.0.0.1', '--port', '0'],
      cwd: options.cwd
    },
    { ...options.env, OPENCODE_SERVER_USERNAME: 'opencode', OPENCODE_SERVER_PASSWORD: password },
    process.platform,
    // `opencode serve` never exits on stdin end, so on POSIX only its supervisor stops it with Orca.
    { lifetime: 'one-shot' }
  )
  const child = spawnProcess({
    program: spawnSpec.program,
    args: spawnSpec.args,
    cwd: options.cwd,
    env: spawnSpec.env,
    detached: true
  })
  const output = createOutputSink(4096)
  let childClosed = false
  let rootExited = false
  const closed = new Promise<boolean>((resolve) => {
    child.once('close', () => {
      childClosed = true
      resolve(true)
    })
  })
  let failed = false
  child.on('error', () => {
    failed = true
  })
  child.once('exit', () => {
    rootExited = true
    failed = true
  })
  child.stdout.on('data', output.write)
  child.stdout.on('error', () => {
    failed = true
  })
  child.stderr.on('error', () => {
    failed = true
  })
  child.stderr.resume()
  child.stdin.on('error', () => {
    failed = true
  })
  child.stdin.end()
  const signal = AbortSignal.any([
    AbortSignal.timeout(10_000),
    ...(options.signal ? [options.signal] : [])
  ])
  let context: OpenCodeLaunchModelContext | null = null
  let stopped = false
  try {
    while (!failed && !signal.aborted && !output.truncated()) {
      const address = output
        .text()
        .match(/^server listening on (http:\/\/127\.0\.0\.1:\d+)\s*$/m)?.[1]
      if (address) {
        const read = async (endpoint: string): Promise<unknown> => {
          const url = new URL(`/api/${endpoint}`, address)
          url.searchParams.set('location[directory]', options.cwd)
          const response = await fetch(url, {
            headers: {
              Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
            },
            redirect: 'error',
            signal
          })
          try {
            if (!response.ok) {
              throw new Error('OpenCode model preflight refused')
            }
            return await readFetchResponseJsonWithinLimit<unknown>(response, 1_048_576)
          } finally {
            await cancelUnreadResponseBody(response)
          }
        }
        const [models, agents, defaultModel, config] = await Promise.all([
          read('model'),
          read('agent'),
          read('model/default'),
          read('config')
        ])
        context = parseOpenCodeLaunchModelContext({
          directory: options.cwd,
          models,
          agents,
          defaultModel,
          config
        })
        if (
          context &&
          (!options.expectedPrimaryAgent ||
            context.primaryAgent === options.expectedPrimaryAgent) &&
          (!options.expectedPrimaryModel || context.primaryModel === options.expectedPrimaryModel)
        ) {
          break
        }
        context = null
      }
      await delay(100, undefined, { signal })
    }
  } catch {
    context = null
  } finally {
    if (spawnSpec.supervised) {
      stopped = await stopSupervisedPreflight(child, closed)
    } else {
      if (!childClosed && !rootExited) {
        await signalProcessTree(child, 'SIGTERM')
      }
      stopped = childClosed || (await withTimeout(closed, 1_500, false))
      // A reaped root's PID can be reused while descendants still hold its pipes.
      if (!stopped && !rootExited) {
        stopped = await forceTerminateProcessTree(child)
      }
    }
  }
  return stopped ? context : null
}

/**
 * True only when the server's group is proven gone: the supervisor exited on its own stop or
 * relayed the server's exit. A forced stop proves nothing: its teardown reaches the supervisor's
 * group, not the server's own detached group. Exit 1 can be a group reap that failed.
 */
async function stopSupervisedPreflight(
  child: ChildProcessHandle,
  closed: Promise<boolean>
): Promise<boolean> {
  if (!child.pid) {
    // Never started, so there is nothing to stop.
    return true
  }
  const { root, tree } = await stopSupervisedChildProcess(child, {
    site: OPENCODE_PREFLIGHT_KILL_SITE
  })
  const forced = tree !== null || child.signalCode === 'SIGKILL'
  const failedReap = child.signalCode === null && child.exitCode === 1
  if (root !== 'exited' || forced || failedReap) {
    return false
  }
  return withTimeout(closed, SUPERVISOR_PIPE_CLOSE_MS, false)
}
