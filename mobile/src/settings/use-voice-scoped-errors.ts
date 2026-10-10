import { useCallback, useMemo, useState } from 'react'
import type { VoiceRequestScope } from './use-voice-request-fence'

/** Reads (loads and polls) get their own slot so a refresh never clears a write's failure. */
export type VoiceErrorScope = 'read' | VoiceRequestScope

type ScopedError = { scope: VoiceErrorScope; message: string }

/** One error slot per Voice scope, so clearing one scope never hides another's failure. */
export function useVoiceScopedErrors() {
  const [errors, setErrors] = useState<readonly ScopedError[]>([])
  const setScopeError = useCallback((scope: VoiceErrorScope, message: string | null) => {
    setErrors((prev) => {
      const rest = prev.filter((entry) => entry.scope !== scope)
      if (message === null) {
        // Why: keep the same array when nothing was cleared so idle polls don't re-render.
        return rest.length === prev.length ? prev : rest
      }
      return [{ scope, message }, ...rest]
    })
  }, [])
  const clearErrors = useCallback(() => {
    setErrors((prev) => (prev.length === 0 ? prev : []))
  }, [])
  // Why: two scopes can fail with the same text; one line is enough and keeps list keys unique.
  const messages = useMemo(() => [...new Set(errors.map((entry) => entry.message))], [errors])
  const error = useMemo(() => (messages.length === 0 ? null : messages.join('\n')), [messages])
  return { error, errors: messages, setScopeError, clearErrors }
}
