import type { WslHostService } from './wsl-host-service'

let instance: WslHostService | null = null

/** Null where WSL hosts cannot exist (not Windows, no e2e fake). */
export function getWslHostService(): WslHostService | null {
  return instance
}

export function setWslHostService(service: WslHostService | null): void {
  instance = service
}
