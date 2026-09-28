/** Captured operation identity; account selection remains keyed by distro. */
export type WslAccountExecutionContext = Readonly<{
  distro: string
  userName: string
  userId: string
  home: string
}>

export function assertWslAccountExecutionTarget(
  execution: WslAccountExecutionContext,
  target?: { runtime?: 'host' | 'wsl'; wslDistro?: string | null }
): void {
  if (
    target?.runtime !== 'wsl' ||
    target.wslDistro?.toLowerCase() !== execution.distro.toLowerCase() ||
    !execution.userName ||
    /[\0\r\n]/.test(execution.userName) ||
    !/^\d+$/.test(execution.userId) ||
    !execution.home.startsWith('/')
  ) {
    throw new Error('WSL account preparation does not match the captured execution owner')
  }
}
