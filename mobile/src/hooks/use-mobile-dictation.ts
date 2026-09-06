import type { HostSessionDictationOperations } from '../session/host-session-dictation-operations'
import type {
  UseMobileDictationOptions,
  UseMobileDictationResult
} from './mobile-dictation-session-state'
import { useHostedMobileDictation } from './use-hosted-mobile-dictation'
import { useNativeMobileDictation } from './use-native-mobile-dictation'

export type { UseMobileDictationResult } from './mobile-dictation-session-state'

export function useMobileDictation(
  options: UseMobileDictationOptions & {
    operations?: HostSessionDictationOperations | null
  }
): UseMobileDictationResult {
  const hosted = useHostedMobileDictation({
    operations: options.operations ?? null,
    enabled: options.enabled && options.operations != null,
    onTranscript: options.onTranscript,
    onError: options.onError
  })
  const native = useNativeMobileDictation({
    client: options.client,
    enabled: options.enabled && options.operations == null,
    onTranscript: options.onTranscript,
    onError: options.onError
  })
  return options.operations ? hosted : native
}
