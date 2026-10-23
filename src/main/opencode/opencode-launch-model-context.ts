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
import { guardSupervisedProviderGroup } from '../provider-process/provider-group-orphan-guard'

const OPENCODE_PREFLIGHT_KILL_SITE = 'opencode-launch-model-preflight'
// A supervisor's pipes are its own, so they close as it exits.
const SUPERVISOR_PIPE_CLOSE_MS = 1_000

const agent = z.object({
  id: z.string(),
  mode: z.string().optional(),
  hidden: z.boolean().optional()
})
const location = z.object({ directory: z.string() })
const agentResponse = z.object({ location, data: z.unknown().array() })
const configResponse = z.array(
  z.object({
    info: z.object({ default_agent: z.string().optional() }).optional()
  })
)

export type OpenCodeLaunchModelContext = {
  primaryAgent: string
}

export function parseOpenCodeLaunchModelContext(options: {
  directory: string
  agents: unknown
  config: unknown
}): OpenCodeLaunchModelContext | null {
  const agents = agentResponse.safeParse(options.agents)
  const config = configResponse.safeParse(options.config)
  if (agents.success && agents.data.location.directory !== options.directory) {
    return null
  }
  const configured = config.success
    ? config.data.reduce<string | undefined>(
        (value, entry) => entry.info?.default_agent ?? value,
        undefined
      )
    : undefined
  const primary = agents.success
    ? agents.data.data
        .map((item) => agent.safeParse(item))
        .find((item) => item.success && item.data.mode !== 'subagent' && !item.data.hidden)
    : undefined
  const primaryAgent = configured || (primary?.success ? primary.data.id : undefined)
  return primaryAgent ? { primaryAgent } : null
}

export async function probeOpenCodeLaunchModelContext(options: {
  executable: string
  cwd: string
  env: NodeJS.ProcessEnv
  signal?: AbortSignal
}): Promise<OpenCodeLaunchModelContext | null> {
  const password = randomBytes(32).toString('base64url')
  const spawnSpec = createProviderSpawnSpec(
    {
      command: options.executable,
      args: ['serve', '--hostname', '127.0.0.1', '--port', '0'],
      cwd: options.cwd
    },
    {
      ...options.env,
      OPENCODE_SERVER_USERNAME: 'opencode',
      OPENCODE_SERVER_PASSWORD: password
    },
    process.platform,
    // `opencode serve` never exits on stdin end, so on POSIX only its supervisor stops it with Orca.
    { lifetime: 'one-shot' }
  )
  const child = spawnProcess({
    program: spawnSpec.program,
    args: spawnSpec.args,
    cwd: options.cwd,
    env: spawnSpec.env,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe', ...spawnSpec.groupReportStdio]
  })
  guardSupervisedProviderGroup(child, {
    site: OPENCODE_PREFLIGHT_KILL_SITE,
    supervised: spawnSpec.supervised
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
        const [agents, config] = await Promise.all([read('agent'), read('config')])
        context = parseOpenCodeLaunchModelContext({
          directory: options.cwd,
          agents,
          config
        })
        break
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
