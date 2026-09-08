import type { HostScreenShellOperations } from './host-screen-shell-operations'

const missingWebBinding = (): never => {
  throw new Error('Hosted HostScreen shell operations were not supplied')
}

const defaultWebHostScreenShellOperations: HostScreenShellOperations = {
  leaveHost: missingWebBinding,
  navigateFromHostList: missingWebBinding,
  openConnectionDiagnostics: missingWebBinding,
  openExternalUrl: missingWebBinding,
  reconnect: missingWebBinding,
  repairPairing: missingWebBinding,
  removeHost: missingWebBinding
}

export function useDefaultHostScreenShellOperations(): HostScreenShellOperations {
  return defaultWebHostScreenShellOperations
}
