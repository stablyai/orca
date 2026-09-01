import type { IPtyProvider } from '../providers/types'
import {
  isPtyShutdownFenceUnavailable,
  type PtyShutdownOptions,
  type PtyShutdownResult
} from '../providers/pty-provider-contract'

export async function shutdownDegradedDaemonWithOutcome(
  id: string,
  opts: PtyShutdownOptions,
  providerFor: (id: string) => IPtyProvider,
  sessionProviders: Map<string, IPtyProvider>
): Promise<PtyShutdownResult | void> {
  const provider = providerFor(id)
  const result = provider.shutdownWithOutcome
    ? await provider.shutdownWithOutcome(id, opts)
    : await provider.shutdown(id, opts)
  if (!opts.keepHistory && !isPtyShutdownFenceUnavailable(result)) {
    sessionProviders.delete(id)
  }
  return result
}
