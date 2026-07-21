export type TrustedRendererCapability = 'ui' | 'clipboard' | 'pty' | 'browser'

class TrustedRendererRegistry {
  private readonly capabilitiesByWebContentsId = new Map<number, Set<TrustedRendererCapability>>()

  grant(webContentsId: number, capability: TrustedRendererCapability): void {
    if (!Number.isInteger(webContentsId)) {
      return
    }
    let capabilities = this.capabilitiesByWebContentsId.get(webContentsId)
    if (!capabilities) {
      capabilities = new Set<TrustedRendererCapability>()
      this.capabilitiesByWebContentsId.set(webContentsId, capabilities)
    }
    capabilities.add(capability)
  }

  grantMany(webContentsId: number, capabilities: TrustedRendererCapability[]): void {
    for (const capability of capabilities) {
      this.grant(webContentsId, capability)
    }
  }

  revoke(webContentsId: number, capability?: TrustedRendererCapability): void {
    if (!capability) {
      this.capabilitiesByWebContentsId.delete(webContentsId)
      return
    }
    const capabilities = this.capabilitiesByWebContentsId.get(webContentsId)
    if (!capabilities) {
      return
    }
    capabilities.delete(capability)
    if (capabilities.size === 0) {
      this.capabilitiesByWebContentsId.delete(webContentsId)
    }
  }

  has(webContentsId: number, capability: TrustedRendererCapability): boolean {
    return this.capabilitiesByWebContentsId.get(webContentsId)?.has(capability) === true
  }

  hasAny(capability: TrustedRendererCapability): boolean {
    for (const capabilities of this.capabilitiesByWebContentsId.values()) {
      if (capabilities.has(capability)) {
        return true
      }
    }
    return false
  }

  clearWebContents(webContentsId: number): void {
    this.capabilitiesByWebContentsId.delete(webContentsId)
  }
}

export const trustedRendererRegistry = new TrustedRendererRegistry()
