let listener: (environmentId: string) => void | Promise<void> = () => {}

export function setManagedOrcadPairingRepairedListener(
  next: (environmentId: string) => void | Promise<void>
): void {
  listener = next
}

export function notifyManagedOrcadPairingRepaired(environmentId: string): void | Promise<void> {
  return listener(environmentId)
}
