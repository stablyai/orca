// In-memory Orca sandbox control plane behind `fetch`, speaking the real wire schemas.
import { encodePairingOffer } from '../../shared/remote-runtime/pairing/pairing'
import {
  HostedSandboxCreateRequestSchema,
  HostedSandboxLeaseRequestSchema,
  type HostedSandboxView
} from '../../shared/hosted-sandbox/hosted-sandbox-wire'

const SESSION_CAP_MS = 24 * 60 * 60_000
const LEASE_MS = 30 * 60_000

export type FakeHostedControlPlane = {
  fetch: typeof fetch
  token: string
  sandboxes: Map<string, HostedSandboxView>
  /** Next lifecycle start is refused by billing with this reason. */
  denyNextStart: (reason: string) => void
  requests: { method: string; path: string; authorization: string | null }[]
  /** False models an image built before the remote desktop. */
  desktopInstalled: boolean
  /** Desktop starts served (each mints one ticket). */
  desktopTickets: number
}

export function createFakeHostedControlPlane(
  options: { now?: () => number } = {}
): FakeHostedControlPlane {
  let clock = 1_700_000_000_000
  const now = options.now ?? (() => (clock += 1000))
  const sandboxes = new Map<string, HostedSandboxView>()
  const requests: FakeHostedControlPlane['requests'] = []
  let pendingDeny: string | null = null
  let nextId = 1
  const token = 'orca-sandbox-test-token'

  const json = (body: unknown, status = 200): Response => Response.json(body, { status })
  const fail = (error: string, status: number, reason?: string): Response =>
    json(reason ? { error, reason } : { error }, status)
  const session = (): NonNullable<HostedSandboxView['session']> => {
    const startedAt = now()
    return {
      id: `sess_${nextId++}`,
      startedAt,
      deadlineAt: startedAt + SESSION_CAP_MS - 10 * 60_000,
      leaseExpiresAt: startedAt + LEASE_MS
    }
  }
  const ready = (sandbox: HostedSandboxView): Response =>
    json({
      sandbox,
      connection: {
        type: 'orca-server',
        pairingCode: encodePairingOffer({
          v: 2,
          endpoint: `wss://${sandbox.id}.sandbox.test`,
          deviceToken: `device-${sandbox.id}`,
          publicKeyB64: Buffer.alloc(32, 7).toString('base64')
        }),
        projectRoot: '/vercel/project'
      }
    })
  const takeDeny = (): string | null => {
    const reason = pendingDeny
    pendingDeny = null
    return reason
  }

  async function handle(method: string, path: string, body: unknown): Promise<Response> {
    if (method === 'POST' && path === '/v1/sandboxes') {
      const parsed = HostedSandboxCreateRequestSchema.safeParse(body)
      if (!parsed.success) {
        return fail('invalid_request', 400)
      }
      const denied = takeDeny()
      if (denied) {
        return fail('entitlement_denied', 403, denied)
      }
      const existing = [...sandboxes.values()].find(
        (sandbox) => sandbox.workspaceId === parsed.data.workspaceId && sandbox.status === 'running'
      )
      if (existing) {
        return ready(existing)
      }
      const sandbox: HostedSandboxView = {
        id: `sbx_${nextId++}`,
        workspaceId: parsed.data.workspaceId,
        status: 'running',
        machineSize: parsed.data.machineSize,
        region: parsed.data.region ?? 'iad1',
        session: session(),
        createdAt: now()
      }
      sandboxes.set(sandbox.id, sandbox)
      return ready(sandbox)
    }
    if (method === 'GET' && path === '/v1/sandboxes') {
      return json({ sandboxes: [...sandboxes.values()] })
    }
    const match = /^\/v1\/sandboxes\/([^/]+)(\/[a-z]+)?$/.exec(path)
    const sandbox = match ? sandboxes.get(decodeURIComponent(match[1]!)) : undefined
    if (!match || !sandbox) {
      return fail('not_found', 404)
    }
    const action = `${method} ${match[2] ?? ''}`
    if (action === 'GET ') {
      return json({ sandbox })
    }
    if (action === 'DELETE ') {
      Object.assign(sandbox, { status: 'destroyed', session: null })
      return json({ sandbox })
    }
    if (sandbox.status === 'destroyed') {
      return fail('conflict', 409)
    }
    switch (action) {
      case 'POST /suspend':
        Object.assign(sandbox, { status: 'suspended', session: null })
        return json({ sandbox })
      case 'POST /resume': {
        if (sandbox.status === 'running') {
          return ready(sandbox)
        }
        const denied = takeDeny()
        if (denied) {
          return fail('entitlement_denied', 403, denied)
        }
        Object.assign(sandbox, { status: 'running', session: session() })
        return ready(sandbox)
      }
      case 'POST /lease': {
        const parsed = HostedSandboxLeaseRequestSchema.safeParse(body)
        if (!parsed.success) {
          return fail('invalid_request', 400)
        }
        if (sandbox.status !== 'running' || !sandbox.session) {
          return fail('conflict', 409)
        }
        sandbox.session.leaseExpiresAt = Math.min(
          sandbox.session.deadlineAt,
          now() + parsed.data.extendMs
        )
        return json({ sandbox })
      }
      case 'POST /desktop':
        if (sandbox.status !== 'running') {
          return fail('conflict', 409, `sandbox_${sandbox.status}`)
        }
        fake.desktopTickets += 1
        return fake.desktopInstalled
          ? json({
              desktop: {
                port: 6080,
                path: 'vnc.html',
                // A fresh single-use ticket per call, as orca-desktop-start mints them.
                ticket: String(fake.desktopTickets).padStart(43, 't'),
                expiresInMs: 60_000
              }
            })
          : fail('conflict', 409, 'desktop_not_installed')
      case 'POST /rollover':
        if (sandbox.status !== 'running') {
          return fail('conflict', 409)
        }
        Object.assign(sandbox, { session: session() })
        return ready(sandbox)
      default:
        return fail('not_found', 404)
    }
  }

  const fakeFetch: typeof fetch = async (input, init) => {
    if (init?.signal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError')
    }
    const url = new URL(input instanceof Request ? input.url : String(input))
    const method = init?.method ?? 'GET'
    const authorization = new Headers(init?.headers).get('authorization')
    requests.push({ method, path: url.pathname, authorization })
    if (authorization !== `Bearer ${token}`) {
      return fail('unauthorized', 401)
    }
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    return handle(method, url.pathname, body)
  }

  const fake: FakeHostedControlPlane = {
    fetch: fakeFetch,
    token,
    sandboxes,
    denyNextStart: (reason) => {
      pendingDeny = reason
    },
    requests,
    desktopInstalled: true,
    desktopTickets: 0
  }
  return fake
}
