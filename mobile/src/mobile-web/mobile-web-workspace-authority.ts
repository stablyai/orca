import { MobileWebBrokerError } from './mobile-web-broker-error'

declare const hostWorkspaceIdBrand: unique symbol

/** Host-side identifiers the authority mints from an opaque page handle. Branding keeps a page
 * handle from being passed back in as if it were already resolved. */
export type MobileWebHostWorkspaceId = string & { readonly [hostWorkspaceIdBrand]: true }

/** A value the host itself reported as a host identifier, so it never came from the page. Every
 * use is a boundary annotation, not a conversion of a page handle. */
export function mobileWebHostWorkspaceIdFromHost(value: string): MobileWebHostWorkspaceId {
  return value as MobileWebHostWorkspaceId
}

export class MobileWebWorkspaceAuthority {
  private readonly pageWorkspaceIdByHostId = new Map<string, string>()
  private readonly hostWorkspaceIdByPageId = new Map<string, string>()
  private nextHandle = 0

  constructor(private readonly randomBytes: (length: number) => Uint8Array) {}

  synchronize(hostWorkspaceIds: readonly string[]): void {
    const present = new Set(hostWorkspaceIds)
    for (const hostWorkspaceId of this.pageWorkspaceIdByHostId.keys()) {
      if (!present.has(hostWorkspaceId)) {
        const pageWorkspaceId = this.pageWorkspaceIdByHostId.get(hostWorkspaceId)
        this.pageWorkspaceIdByHostId.delete(hostWorkspaceId)
        if (pageWorkspaceId) {
          this.hostWorkspaceIdByPageId.delete(pageWorkspaceId)
        }
      }
    }
    for (const hostWorkspaceId of hostWorkspaceIds) {
      this.rememberWorkspace(hostWorkspaceId)
    }
  }

  pageWorkspaceId(hostWorkspaceId: string): string {
    const pageWorkspaceId = this.pageWorkspaceIdByHostId.get(hostWorkspaceId)
    if (!pageWorkspaceId) {
      throw new MobileWebBrokerError('not_found')
    }
    return pageWorkspaceId
  }

  hostWorkspaceId(pageWorkspaceId: string): MobileWebHostWorkspaceId {
    const hostWorkspaceId = this.hostWorkspaceIdByPageId.get(pageWorkspaceId)
    if (!hostWorkspaceId) {
      throw new MobileWebBrokerError('not_found')
    }
    return hostWorkspaceId as MobileWebHostWorkspaceId
  }

  assertHostWorkspaceBinding(
    pageWorkspaceId: string,
    expectedHostWorkspaceId: MobileWebHostWorkspaceId
  ): void {
    if (this.hostWorkspaceId(pageWorkspaceId) !== expectedHostWorkspaceId) {
      throw new MobileWebBrokerError('conflict')
    }
  }

  registerWorkspace(hostWorkspaceId: string): string {
    this.rememberWorkspace(hostWorkspaceId)
    return this.pageWorkspaceId(hostWorkspaceId)
  }

  clear(): void {
    this.pageWorkspaceIdByHostId.clear()
    this.hostWorkspaceIdByPageId.clear()
  }

  private rememberWorkspace(hostWorkspaceId: string): void {
    if (this.pageWorkspaceIdByHostId.has(hostWorkspaceId)) {
      return
    }
    const pageWorkspaceId = this.createHandle()
    this.pageWorkspaceIdByHostId.set(hostWorkspaceId, pageWorkspaceId)
    this.hostWorkspaceIdByPageId.set(pageWorkspaceId, hostWorkspaceId)
  }

  private createHandle(): string {
    const bytes = this.randomBytes(16)
    if (bytes.byteLength !== 16) {
      throw new MobileWebBrokerError('internal')
    }
    const counter = this.nextHandle.toString(36)
    this.nextHandle += 1
    return `workspace_${counter}_${Array.from(bytes, byteToHex).join('')}`
  }
}

function byteToHex(value: number): string {
  return value.toString(16).padStart(2, '0')
}
