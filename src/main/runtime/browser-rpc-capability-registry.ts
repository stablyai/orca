import { randomBytes, randomUUID } from 'node:crypto'
import type { RpcRequest } from './rpc/core'

const MAX_CAPABILITY_TTL_MS = 2 * 60 * 60 * 1_000
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
  'browser.eval',
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
  'browser.find',
  'browser.console',
  'browser.network',
  'browser.capture.start',
  'browser.capture.stop',
  'browser.highlight',
  'browser.setDevice',
  'browser.setOffline',
  'browser.setMedia',
  'browser.storageLocalGet',
  'browser.storageLocalSet',
  'browser.storageLocalClear',
  'browser.storageSessionGet',
  'browser.storageSessionSet',
  'browser.storageSessionClear'
])

type BrowserRpcCapability = {
  id: string
  token: string
  browserPageId: string
  browserProfileId: string
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
    worktreeId?: string
    ttlMs: number
  }): BrowserRpcCapability {
    if (
      !input.browserPageId ||
      !input.browserProfileId ||
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
    const params = rawParams && typeof rawParams === 'object' ? { ...rawParams } : {}
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
