// HTTP clients for the dev control plane, the dev billing Worker and Vercel (read/cleanup only).
// Every sandbox create/destroy goes through `Sandboxes` so the run ledger is always complete.
import { createVercelSandboxApi } from '../../sandbox-control/src/vercel-sandbox-api.ts'
import { config, secrets } from './env'
import type { RunState } from './run-state'
import { billingToken, sandboxToken, type Identity } from './tokens'

export type Reply<T = any> = { status: number; ms: number; body: T; headers: Headers }

async function call<T = any>(base: string, method: string, path: string, bearer: string, body?: unknown): Promise<Reply<T>> {
  const started = performance.now()
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual'
  })
  const text = await response.text()
  let parsed: unknown = text
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    // keep text
  }
  return { status: response.status, ms: Math.round(performance.now() - started), body: parsed as T, headers: response.headers }
}

export const control = {
  as: async (who: Identity, method: string, path: string, body?: unknown) =>
    call<any>(config.controlPlaneUrl, method, path, await sandboxToken(who), body),
  operator: (method: string, path: string, body?: unknown) => {
    const token = secrets.operatorToken()
    if (!token) {
      throw new Error('missing operator-dev.json')
    }
    return call(config.controlPlaneUrl, method, path, token, body)
  },
  raw: (method: string, path: string, bearer: string, body?: unknown) => call<any>(config.controlPlaneUrl, method, path, bearer, body)
}

export const billing = {
  as: async (who: Identity, method: string, path: string, body?: unknown) =>
    call<any>(config.billingUrl, method, path, await billingToken(who), body),
  raw: (method: string, path: string, bearer: string, body?: unknown) => call<any>(config.billingUrl, method, path, bearer, body)
}

let vercelApi: ReturnType<typeof createVercelSandboxApi> | null = null
export function vercel() {
  const token = secrets.vercelToken()
  if (!token) {
    throw new Error('missing tok.json (Vercel token)')
  }
  vercelApi ??= createVercelSandboxApi({ token, teamId: config.vercelTeamId, projectId: config.vercelProjectId })
  return vercelApi
}

export async function vercelRest(method: string, path: string, query: Record<string, string> = {}) {
  const url = new URL(`https://vercel.com/api${path}`)
  url.searchParams.set('teamId', config.vercelTeamId)
  for (const [k, v] of Object.entries(query)) {
    url.searchParams.set(k, v)
  }
  const response = await fetch(url, { method, headers: { authorization: `Bearer ${secrets.vercelToken()}` } })
  const text = await response.text()
  return { status: response.status, json: text ? (JSON.parse(text) as any) : null }
}

export type SandboxView = {
  id: string
  workspaceId: string
  status: string
  machineSize: string
  session: { id: string; startedAt: number; deadlineAt: number; leaseExpiresAt: number } | null
}
export type ReadyView = { sandbox: SandboxView; connection: { type: 'orca-server'; pairingCode: string; projectRoot: string } }

const VCPUS: Record<string, number> = { standard: 4, large: 8 }

/** Lifecycle calls with ledger bookkeeping; the provider name is `orca-<env>-<id>` (dev: orca-dev-). */
export class Sandboxes {
  private live = new Map<string, { who: Identity; since: number | null }>()
  constructor(private readonly run: RunState) {}

  get count(): number {
    return this.live.size
  }

  async create(
    who: Identity,
    body: { workspaceId: string; machineSize?: 'standard' | 'large'; repo?: { url: string; ref?: string } }
  ): Promise<Reply<ReadyView & { error?: string; reason?: string }>> {
    if (this.live.size >= config.maxConcurrentSandboxes) {
      throw new Error(`eval concurrency cap (${config.maxConcurrentSandboxes}) reached`)
    }
    const reply = await control.as(who, 'POST', '/v1/sandboxes', { machineSize: 'standard', ...body })
    if (reply.status === 200 && reply.body?.sandbox?.id) {
      const id = reply.body.sandbox.id
      this.run.created({ kind: 'sandbox', id, label: `orca-dev-${id} (${body.workspaceId})`, vcpus: VCPUS[reply.body.sandbox.machineSize] ?? 4 })
      this.live.set(id, { who, since: Date.now() })
    }
    return reply
  }

  private stopClock(id: string): void {
    const entry = this.live.get(id)
    if (entry?.since) {
      this.run.addRunning('sandbox', id, Date.now() - entry.since)
      entry.since = null
    }
  }

  async suspend(id: string): Promise<Reply<{ sandbox: SandboxView }>> {
    const reply = await control.as(this.who(id), 'POST', `/v1/sandboxes/${id}/suspend`)
    if (reply.status === 200) {
      this.stopClock(id)
    }
    return reply
  }

  async resume(id: string): Promise<Reply<ReadyView>> {
    const reply = await control.as(this.who(id), 'POST', `/v1/sandboxes/${id}/resume`)
    const entry = this.live.get(id)
    if (reply.status === 200 && entry && !entry.since) {
      entry.since = Date.now()
    }
    return reply
  }

  async rollover(id: string): Promise<Reply<ReadyView>> {
    return control.as(this.who(id), 'POST', `/v1/sandboxes/${id}/rollover`)
  }

  async get(id: string): Promise<Reply<{ sandbox: SandboxView }>> {
    return control.as(this.who(id), 'GET', `/v1/sandboxes/${id}`)
  }

  async destroy(id: string): Promise<Reply<{ sandbox: SandboxView }>> {
    const reply = await control.as(this.who(id), 'DELETE', `/v1/sandboxes/${id}`)
    if (reply.status === 200 || reply.status === 404) {
      this.stopClock(id)
      this.run.destroyed('sandbox', id)
      this.live.delete(id)
    }
    return reply
  }

  /** Destroy everything this run still holds, then verify nothing of ours is left at Vercel. */
  async destroyAll(): Promise<{ destroyed: string[]; failed: string[] }> {
    const destroyed: string[] = []
    const failed: string[] = []
    for (const id of [...this.live.keys()]) {
      const reply = await this.destroy(id).catch(() => null)
      ;(reply && (reply.status === 200 || reply.status === 404) ? destroyed : failed).push(id)
    }
    return { destroyed, failed }
  }

  /** Commands on the VM over Vercel's API (operator path, not the user path). */
  async exec(sessionId: string, script: string, timeoutMs = 60_000) {
    return vercel().runCommand(sessionId, { command: 'bash', args: ['-c', script], timeoutMs })
  }

  private who(id: string): Identity {
    const entry = this.live.get(id)
    if (!entry) {
      throw new Error(`sandbox ${id} is not tracked by this run`)
    }
    return entry.who
  }

  adopt(id: string, who: Identity): void {
    this.live.set(id, { who, since: Date.now() })
  }
}
