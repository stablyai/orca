import { rebindLocalProviderListeners } from '../ipc/pty'
import { getDaemonRuntimeDir, getDaemonHistoryDir } from './daemon-launch-paths'
import { createDaemonRecoveryProvider } from './daemon-recovery-provider'
import { installDaemonProvider } from './daemon-provider-state'

export function initDaemonRecoveryProvider(): void {
  const provider = createDaemonRecoveryProvider(getDaemonRuntimeDir(), getDaemonHistoryDir())
  installDaemonProvider(null, provider)
  rebindLocalProviderListeners()
}
