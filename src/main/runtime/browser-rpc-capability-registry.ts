import { randomBytes, randomUUID } from 'node:crypto'
import { isBrowserNetworkUrlAllowed } from '../../shared/browser-domain-policy'
import type { RpcRequest } from './rpc/core'

const MAX_CAPABILITY_TTL_MS = 2 * 60 * 60 * 1_000
const SAFE_BROWSER_GET_PROPERTIES = new Set(['text', 'url', 'title', 'count', 'box', 'styles'])
const ALLOWED_BROWSER_CAPABILITY_METHODS = new Set([
  'status.get',
  'browser.snapshot',
  'browser.click',
  'browser.goto',
  'browser.fill',
  'browser.type',
  'browser.select',
  'browser.scroll',
  'browser.back',
  'browser.reload',
  'browser.screenshot',
  'browser.hover',
  'browser.drag',
  'browser.wait',
  'browser.check',
  'browser.focus',
  'browser.clear',
  'browser.selectAll',
  'browser.keypress',
  'browser.pdf',
  'browser.fullScreenshot',
  'browser.dblclick',
  'browser.forward',
  'browser.scrollIntoView',
  'browser.get',
  'browser.is',
  'browser.console',
  'browser.highlight',
  'browser.setDevice',
  'browser.setOffline',
  'browser.setMedia'
])

type BrowserRpcCapability = {
  id: string
  token: string
  browserPageId: string
  browserProfileId: string
  allowedDomains: string[]
  worktreeId?: string
  expiresAt: number
}

export class BrowserRpcCapabilityError extends Error {
  constructor(
    readonly code: 'invalid' | 'expired' | 'forbidden',
    message: string
  ) {
    super(message)
    this.name = 'BrowserRpcCapabilityError'
  }
}

export class BrowserRpcCapabilityRegistry {
  private readonly byToken = new Map<string, BrowserRpcCapability>()
  private readonly tokenById = new Map<string, string>()
  private readonly now: () => number

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now
  }

  create(input: {
    browserPageId: string
    browserProfileId: string
    allowedDomains: string[]
    worktreeId?: string
    ttlMs: number
  }): BrowserRpcCapability {
    if (
      !input.browserPageId ||
      !input.browserProfileId ||
      input.allowedDomains.length === 0 ||
      input.ttlMs <= 0 ||
      input.ttlMs > MAX_CAPABILITY_TTL_MS
    ) {
      throw new BrowserRpcCapabilityError('invalid', 'Invalid browser capability request')
    }
    const capability: BrowserRpcCapability = {
      id: randomUUID(),
      token: randomBytes(32).toString('hex'),
      browserPageId: input.browserPageId,
      browserProfileId: input.browserProfileId,
      allowedDomains: [...input.allowedDomains],
      ...(input.worktreeId ? { worktreeId: input.worktreeId } : {}),
      expiresAt: this.now() + input.ttlMs
    }
    this.byToken.set(capability.token, capability)
    this.tokenById.set(capability.id, capability.token)
    return capability
  }

  authorize(token: string, request: RpcRequest): RpcRequest {
    const capability = this.requireActive(token)
    if (!ALLOWED_BROWSER_CAPABILITY_METHODS.has(request.method)) {
      throw new BrowserRpcCapabilityError(
        'forbidden',
        `Method '${request.method}' is not available to browser capabilities`
      )
    }
    if (request.method === 'status.get') {
      return request
    }

    const rawParams = request.params
    const params: Record<string, unknown> =
      rawParams && typeof rawParams === 'object'
        ? { ...(rawParams as Record<string, unknown>) }
        : {}
    if ('page' in params && params.page !== capability.browserPageId) {
      throw new BrowserRpcCapabilityError('forbidden', 'Browser capability page mismatch')
    }
    if (
      capability.worktreeId &&
      'worktree' in params &&
      params.worktree !== capability.worktreeId
    ) {
      throw new BrowserRpcCapabilityError('forbidden', 'Browser capability worktree mismatch')
    }
    if (request.method === 'browser.goto') {
      const url = typeof params.url === 'string' ? params.url : ''
      const protocol = safeUrlProtocol(url)
      if (
        (protocol !== 'http:' && protocol !== 'https:') ||
        !isBrowserNetworkUrlAllowed(url, capability.allowedDomains)
      ) {
        throw new BrowserRpcCapabilityError(
          'forbidden',
          'Browser capability navigation is outside its domain policy'
        )
      }
    }
    if (request.method === 'browser.wait' && typeof params.fn === 'string') {
      throw new BrowserRpcCapabilityError(
        'forbidden',
        'Function waits are not available to browser capabilities'
      )
    }
    if (
      request.method === 'browser.get' &&
      (typeof params.what !== 'string' || !SAFE_BROWSER_GET_PROPERTIES.has(params.what))
    ) {
      throw new BrowserRpcCapabilityError(
        'forbidden',
        'This browser property is not available to browser capabilities'
      )
    }
    return {
      ...request,
      params: {
        ...params,
        page: capability.browserPageId,
        ...(capability.worktreeId ? { worktree: capability.worktreeId } : {})
      }
    }
  }

  getTarget(token: string): { browserPageId: string; browserProfileId: string } {
    const capability = this.requireActive(token)
    return {
      browserPageId: capability.browserPageId,
      browserProfileId: capability.browserProfileId
    }
  }

  revoke(id: string): boolean {
    const token = this.tokenById.get(id)
    const capability = token ? this.byToken.get(token) : undefined
    if (!capability) {
      return false
    }
    this.delete(capability)
    return true
  }

  revokePage(browserPageId: string): number {
    let revoked = 0
    for (const capability of this.byToken.values()) {
      if (capability.browserPageId === browserPageId) {
        this.delete(capability)
        revoked++
      }
    }
    return revoked
  }

  private delete(capability: BrowserRpcCapability): void {
    this.byToken.delete(capability.token)
    this.tokenById.delete(capability.id)
  }

  private requireActive(token: string): BrowserRpcCapability {
    const capability = this.byToken.get(token)
    if (!capability) {
      throw new BrowserRpcCapabilityError('invalid', 'Invalid browser capability')
    }
    if (this.now() > capability.expiresAt) {
      this.delete(capability)
      throw new BrowserRpcCapabilityError('expired', 'Browser capability expired')
    }
    return capability
  }
}

function safeUrlProtocol(rawUrl: string): string {
  try {
    return new URL(rawUrl).protocol
  } catch {
    return ''
  }
}
