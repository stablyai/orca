import { constants, setPriority } from 'node:os'

export function lowerAiVaultServicePriority(pid: number | undefined): boolean {
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) {
    return false
  }
  try {
    setPriority(pid, constants.priority.PRIORITY_BELOW_NORMAL)
    return true
  } catch {
    return false
  }
}
