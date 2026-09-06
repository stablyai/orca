import { MobileWebBrokerError } from './mobile-web-broker-error'

type BrowserPageBinding = {
  hostWorkspaceId: string
  hostPageId: string
}

export class MobileWebBrowserAuthority {
  private readonly pageIdByHostKey = new Map<string, string>()
  private readonly bindingByPageId = new Map<string, BrowserPageBinding>()
  private nextHandle = 0

  constructor(private readonly randomBytes: (length: number) => Uint8Array) {}

  synchronizeWorkspace(hostWorkspaceId: string, hostPageIds: readonly string[]): void {
    const currentPageIds = new Set(hostPageIds)
    for (const [hostKey, pageId] of this.pageIdByHostKey) {
      const binding = this.bindingByPageId.get(pageId)
      if (binding?.hostWorkspaceId === hostWorkspaceId && !currentPageIds.has(binding.hostPageId)) {
        this.pageIdByHostKey.delete(hostKey)
        this.bindingByPageId.delete(pageId)
      }
    }
    hostPageIds.forEach((hostPageId) => this.register(hostWorkspaceId, hostPageId))
  }

  register(hostWorkspaceId: string, hostPageId: string): string {
    const hostKey = browserHostKey(hostWorkspaceId, hostPageId)
    const existing = this.pageIdByHostKey.get(hostKey)
    if (existing) {
      return existing
    }
    const bytes = this.randomBytes(16)
    if (bytes.byteLength !== 16) {
      throw new MobileWebBrokerError('internal')
    }
    const pageId = `browser_${this.nextHandle.toString(36)}_${Array.from(bytes, byteToHex).join('')}`
    this.nextHandle += 1
    this.pageIdByHostKey.set(hostKey, pageId)
    this.bindingByPageId.set(pageId, { hostWorkspaceId, hostPageId })
    return pageId
  }

  hostPageId(hostWorkspaceId: string, pageId: string): string {
    const binding = this.bindingByPageId.get(pageId)
    if (!binding || binding.hostWorkspaceId !== hostWorkspaceId) {
      throw new MobileWebBrokerError('not_found')
    }
    return binding.hostPageId
  }

  hostTabId(hostWorkspaceId: string, pageTabId: string): string {
    const binding = this.bindingByPageId.get(pageTabId)
    if (!binding) {
      if (pageTabId.startsWith('browser_')) {
        throw new MobileWebBrokerError('not_found')
      }
      return pageTabId
    }
    if (binding.hostWorkspaceId !== hostWorkspaceId) {
      throw new MobileWebBrokerError('not_found')
    }
    return binding.hostPageId
  }

  clear(): void {
    this.pageIdByHostKey.clear()
    this.bindingByPageId.clear()
  }
}

function browserHostKey(hostWorkspaceId: string, hostPageId: string): string {
  return `${hostWorkspaceId.length}:${hostWorkspaceId}${hostPageId}`
}

function byteToHex(value: number): string {
  return value.toString(16).padStart(2, '0')
}
