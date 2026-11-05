import { usePageBridgeClientIfPresent } from '../transport/client-context.web'
import { performSessionRailBack } from './duo-rail-back'

/** Page-served sessions use the shell's Back claim; the header path remains when that cannot run. */
export function useSessionRailBack(nativeBack: () => void): () => void {
  const client = usePageBridgeClientIfPresent()
  return () => {
    performSessionRailBack(client ? () => client.pressBack() : null, nativeBack)
  }
}
