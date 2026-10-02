import { getProviderForPty } from '../provider/registry'

export async function requestPtyRedrawFromRuntimeController(ptyId: string): Promise<boolean> {
  try {
    // The provider routes SIGWINCH to the foreground group on the execution host.
    await getProviderForPty(ptyId).sendSignal(ptyId, 'SIGWINCH')
    return true
  } catch {
    return false
  }
}
