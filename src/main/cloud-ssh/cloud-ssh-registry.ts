// Electron-free handle on the desktop's SSH service, so the RPC methods (also bundled into
// headless servers, which never install one) can reach it without importing the desktop wiring.
import type { CloudSshService } from './cloud-ssh-service'

let service: CloudSshService | null = null

export function setCloudSshService(next: CloudSshService | null): void {
  service = next
}

export function getCloudSshService(): CloudSshService | null {
  return service
}
