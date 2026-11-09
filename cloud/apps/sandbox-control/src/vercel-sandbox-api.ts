// Vercel Sandbox REST client for Workers. `@vercel/sandbox` needs undici/fs/xdg paths, so this
// calls the same /v2 + /v3 endpoints its api-client uses (SDK 3.9.1), with Orca's team token.
import { z } from 'zod'
import type { NetworkPolicy } from './network-policy'
import type { GoldenImageProviderApi } from './golden-image-provider'
import {
  ProviderError,
  type CommandResult,
  type ProviderSandboxState,
  type ProviderSession,
  type SandboxProviderApi
} from './sandbox-provider'

export type VercelSandboxApiConfig = {
  token: string
  teamId: string
  projectId: string
  baseUrl?: string
  fetch?: typeof fetch
}

const MAX_COMMAND_OUTPUT = 256 * 1024

const Status = z.enum(['pending', 'running', 'stopping', 'stopped', 'failed', 'aborted', 'snapshotting'])
const Session = z.looseObject({
  id: z.string(),
  status: Status,
  startedAt: z.number().optional(),
  timeout: z.number()
})
const Sandbox = z.looseObject({
  name: z.string(),
  status: Status,
  currentSessionId: z.string(),
  currentSnapshotId: z.string().optional(),
  tags: z.record(z.string(), z.string()).optional()
})
const Route = z.looseObject({ url: z.string(), port: z.number() })
const SandboxAndSession = z.looseObject({ sandbox: Sandbox, session: Session, routes: z.array(Route) })
const Snapshot = z.looseObject({
  id: z.string(),
  status: z.enum(['created', 'deleted', 'failed']),
  sourceSessionId: z.string()
})
const ProjectSnapshot = Snapshot.extend({ creationMethod: z.string().optional(), createdAt: z.number() })
const SandboxSummary = z.looseObject({
  name: z.string(),
  status: Status,
  currentSessionId: z.string(),
  tags: z.record(z.string(), z.string()).optional()
})
const MAX_LISTED = 5000
const ErrorBody = z.looseObject({ error: z.looseObject({ code: z.string().optional() }).optional() })
const CommandLine = z.looseObject({ command: z.looseObject({ exitCode: z.number().nullable() }) })
const OutputLine = z.looseObject({ stream: z.enum(['stdout', 'stderr']), data: z.string() })
const FailureLine = z.looseObject({ stream: z.literal('error'), data: z.looseObject({ code: z.string() }) })

export function createVercelSandboxApi(
  config: VercelSandboxApiConfig
): SandboxProviderApi & GoldenImageProviderApi {
  const base = config.baseUrl ?? 'https://vercel.com/api'
  const doFetch = config.fetch ?? fetch

  async function request(
    method: string,
    path: string,
    options: { query?: Record<string, string | undefined>; body?: unknown } = {}
  ): Promise<Response> {
    const url = new URL(`${base}${path}`)
    url.searchParams.set('teamId', config.teamId)
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, value)
      }
    }
    const response = await doFetch(url, {
      method,
      headers: {
        authorization: `Bearer ${config.token}`,
        'content-type': 'application/json'
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      redirect: 'manual'
    })
    if (!response.ok) {
      const parsed = ErrorBody.safeParse(await response.json().catch(() => null))
      throw new ProviderError(response.status, parsed.success ? (parsed.data.error?.code ?? null) : null)
    }
    return response
  }

  async function json<T>(schema: z.ZodType<T>, response: Response): Promise<T> {
    const parsed = schema.safeParse(await response.json().catch(() => null))
    if (!parsed.success) {
      throw new ProviderError(response.status, 'invalid_response')
    }
    return parsed.data
  }

  const toSession = (session: z.infer<typeof Session>): ProviderSession => ({
    id: session.id,
    status: session.status,
    startedAt: session.startedAt ?? null,
    timeoutMs: session.timeout
  })
  const toState = (body: z.infer<typeof SandboxAndSession>): ProviderSandboxState => ({
    sandbox: {
      name: body.sandbox.name,
      status: body.sandbox.status,
      currentSessionId: body.sandbox.currentSessionId,
      currentSnapshotId: body.sandbox.currentSnapshotId ?? null,
      tags: body.sandbox.tags ?? {}
    },
    session: toSession(body.session),
    routes: body.routes.map((route) => ({ port: route.port, url: route.url }))
  })
  const missingOk = async (operation: () => Promise<unknown>): Promise<void> => {
    try {
      await operation()
    } catch (error) {
      if (!(error instanceof ProviderError && error.status === 404)) {
        throw error
      }
    }
  }

  return {
    async createSandbox(params) {
      // No `runtime` selects /v3, which boots from `source` (the golden snapshot).
      const response = await request('POST', '/v3/sandboxes', {
        body: {
          projectId: config.projectId,
          name: params.name,
          source: { type: 'snapshot', snapshotId: params.snapshotId },
          resources: { vcpus: params.vcpus },
          region: params.region,
          timeout: params.timeoutMs,
          ports: params.ports,
          persistent: true,
          keepLastSnapshots: { count: 2, expiration: params.snapshotExpirationMs },
          snapshotExpiration: params.snapshotExpirationMs,
          networkPolicy: params.networkPolicy,
          tags: params.tags
        }
      })
      return toState(await json(SandboxAndSession, response))
    },

    async getSandbox(name, options) {
      try {
        const response = await request('GET', `/v2/sandboxes/${encodeURIComponent(name)}`, {
          query: { projectId: config.projectId, resume: String(options.resume) }
        })
        return toState(await json(SandboxAndSession, response))
      } catch (error) {
        if (error instanceof ProviderError && error.status === 404) {
          return null
        }
        throw error
      }
    },

    async stopSession(sessionId) {
      const response = await request('POST', `/v2/sandboxes/sessions/${encodeURIComponent(sessionId)}/stop`)
      const body = await json(z.looseObject({ snapshot: Snapshot.optional() }), response)
      return { snapshotId: body.snapshot?.id ?? null }
    },

    async extendTimeout(sessionId, durationMs) {
      const response = await request(
        'POST',
        `/v2/sandboxes/sessions/${encodeURIComponent(sessionId)}/extend-timeout`,
        { body: { duration: durationMs } }
      )
      return toSession((await json(z.looseObject({ session: Session }), response)).session)
    },

    async updateNetworkPolicy(sessionId, policy: NetworkPolicy) {
      await request('POST', `/v2/sandboxes/sessions/${encodeURIComponent(sessionId)}/network-policy`, {
        body: policy
      })
    },

    async runCommand(sessionId, params) {
      const response = await request('POST', `/v2/sandboxes/sessions/${encodeURIComponent(sessionId)}/cmd`, {
        body: {
          command: params.command,
          args: params.args ?? [],
          cwd: params.cwd,
          env: params.env ?? {},
          sudo: params.sudo ?? false,
          wait: true,
          logs: true,
          timeout: params.timeoutMs
        }
      })
      return readCommandStream(response)
    },

    async updateSnapshotExpiration(name, expirationMs) {
      // Archive shortens the provider-side backstop; unarchive restores it. Same fields as create.
      await request('PATCH', `/v2/sandboxes/${encodeURIComponent(name)}`, {
        query: { projectId: config.projectId },
        body: { snapshotExpiration: expirationMs, keepLastSnapshots: { count: 2, expiration: expirationMs } }
      })
    },

    deleteSandbox: (name) =>
      missingOk(() =>
        request('DELETE', `/v2/sandboxes/${encodeURIComponent(name)}`, {
          query: { projectId: config.projectId, deleteOrphanSnapshots: 'true' }
        })
      ),

    async createBuildSandbox(params) {
      // A `runtime` selects /v2: a fresh managed image, not a snapshot.
      const response = await request('POST', '/v2/sandboxes', {
        body: {
          projectId: config.projectId,
          name: params.name,
          runtime: params.runtime,
          resources: { vcpus: params.vcpus },
          region: params.region,
          timeout: params.timeoutMs,
          persistent: false,
          networkPolicy: { mode: 'allow-all' },
          tags: params.tags
        }
      })
      return toState(await json(SandboxAndSession, response))
    },

    async createSnapshot(sessionId, expirationMs) {
      const response = await request('POST', `/v2/sandboxes/sessions/${encodeURIComponent(sessionId)}/snapshot`, {
        body: { expiration: expirationMs }
      })
      return (await json(z.looseObject({ snapshot: Snapshot }), response)).snapshot.id
    },

    // Without deleteOrphanSnapshots: the build sandbox goes, the golden snapshot it produced stays.
    deleteBuildSandbox: (name) =>
      missingOk(() =>
        request('DELETE', `/v2/sandboxes/${encodeURIComponent(name)}`, { query: { projectId: config.projectId } })
      ),

    async startCommand(sessionId, params) {
      const response = await request('POST', `/v2/sandboxes/sessions/${encodeURIComponent(sessionId)}/cmd`, {
        body: { command: params.command, args: params.args ?? [], env: params.env ?? {}, timeout: params.timeoutMs }
      })
      return (await json(z.looseObject({ command: z.looseObject({ id: z.string() }) }), response)).command.id
    },

    async getCommand(sessionId, commandId) {
      const response = await request(
        'GET',
        `/v2/sandboxes/sessions/${encodeURIComponent(sessionId)}/cmd/${encodeURIComponent(commandId)}`
      )
      const body = await json(z.looseObject({ command: z.looseObject({ exitCode: z.number().nullable().optional() }) }), response)
      return { exitCode: body.command.exitCode ?? null }
    },

    async getSnapshot(snapshotId) {
      try {
        const response = await request('GET', `/v2/sandboxes/snapshots/${encodeURIComponent(snapshotId)}`)
        const body = await json(z.looseObject({ snapshot: Snapshot.extend({ expiresAt: z.number().optional() }) }), response)
        return { id: body.snapshot.id, status: body.snapshot.status, expiresAt: body.snapshot.expiresAt ?? null }
      } catch (error) {
        if (error instanceof ProviderError && error.status === 404) {
          return null
        }
        throw error
      }
    },

    async listSnapshots(name) {
      const snapshots: z.infer<typeof Snapshot>[] = []
      let cursor: string | undefined
      do {
        const response = await request('GET', '/v2/sandboxes/snapshots', {
          query: { project: config.projectId, name, limit: '50', cursor }
        })
        const page = await json(
          z.looseObject({
            snapshots: z.array(Snapshot),
            pagination: z.looseObject({ next: z.string().nullable() })
          }),
          response
        )
        snapshots.push(...page.snapshots)
        cursor = page.pagination.next ?? undefined
      } while (cursor && snapshots.length < 1000)
      return snapshots.map((s) => ({ id: s.id, status: s.status, sourceSessionId: s.sourceSessionId }))
    },

    async listSandboxes() {
      const sandboxes: z.infer<typeof SandboxSummary>[] = []
      let cursor: string | undefined
      do {
        const response = await request('GET', '/v2/sandboxes', {
          query: { project: config.projectId, limit: '50', cursor }
        })
        const page = await json(
          z.looseObject({ sandboxes: z.array(SandboxSummary), pagination: z.looseObject({ next: z.string().nullable() }) }),
          response
        )
        sandboxes.push(...page.sandboxes)
        cursor = page.pagination.next ?? undefined
      } while (cursor && sandboxes.length < MAX_LISTED)
      return {
        complete: cursor === undefined,
        sandboxes: sandboxes.map((s) => ({ name: s.name, status: s.status, currentSessionId: s.currentSessionId, tags: s.tags ?? {} }))
      }
    },

    async listProjectSnapshots() {
      const snapshots: z.infer<typeof ProjectSnapshot>[] = []
      let cursor: string | undefined
      do {
        const response = await request('GET', '/v2/sandboxes/snapshots', {
          query: { project: config.projectId, limit: '50', cursor }
        })
        const page = await json(
          z.looseObject({ snapshots: z.array(ProjectSnapshot), pagination: z.looseObject({ next: z.string().nullable() }) }),
          response
        )
        snapshots.push(...page.snapshots)
        cursor = page.pagination.next ?? undefined
      } while (cursor && snapshots.length < MAX_LISTED)
      return {
        complete: cursor === undefined,
        snapshots: snapshots.map((s) => ({ id: s.id, status: s.status, creationMethod: s.creationMethod ?? null, createdAt: s.createdAt }))
      }
    },

    async deleteSnapshot(snapshotId) {
      const path = `/v2/sandboxes/snapshots/${encodeURIComponent(snapshotId)}`
      try {
        await missingOk(() => request('DELETE', path))
      } catch (error) {
        // Vercel answers 400 "Snapshot expired or deleted" for one already gone (found live); confirm, then accept.
        if (!(error instanceof ProviderError && error.status === 400)) {
          throw error
        }
        const current = await json(z.looseObject({ snapshot: Snapshot }), await request('GET', path))
        if (current.snapshot.status !== 'deleted') {
          throw error
        }
      }
    }
  }
}

/** `wait: true` answers ndjson: the command, its log lines, then the finished command. */
async function readCommandStream(response: Response): Promise<CommandResult> {
  const text = await response.text()
  const output = { stdout: '', stderr: '' }
  let exitCode: number | null = null
  for (const line of text.split('\n')) {
    if (!line.trim()) {
      continue
    }
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      throw new ProviderError(response.status, 'invalid_response')
    }
    const command = CommandLine.safeParse(value)
    const log = OutputLine.safeParse(value)
    const failure = FailureLine.safeParse(value)
    if (command.success) {
      exitCode = command.data.command.exitCode ?? exitCode
    } else if (log.success) {
      if (output[log.data.stream].length < MAX_COMMAND_OUTPUT) {
        output[log.data.stream] += log.data.data
      }
    } else if (failure.success) {
      throw new ProviderError(response.status, failure.data.data.code)
    } else {
      throw new ProviderError(response.status, 'invalid_response')
    }
  }
  if (exitCode === null) {
    throw new ProviderError(response.status, 'command_unfinished')
  }
  return { exitCode, ...output }
}
