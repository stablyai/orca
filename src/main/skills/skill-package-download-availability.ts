import { SKILL_INSTALL_CANCELLED_FAILURE } from '../../shared/skill-install-failure'
import { SkillInstallOperationError } from './skill-install-operation-error'

const MAX_TIMEOUT_DELAY_MS = 2_147_483_647

export function throwIfSkillDownloadUnavailable(input: {
  signal?: AbortSignal
  now: () => number
  expiresAt: number
}): void {
  if (input.signal?.aborted) {
    throw new SkillInstallOperationError({
      ...SKILL_INSTALL_CANCELLED_FAILURE,
      code: 'skill-download-cancelled'
    })
  }
  if (input.now() >= input.expiresAt) {
    throw new Error('skill-download-grant-expired')
  }
}

export function isSkillDownloadGrantExpiredAbort(signal: AbortSignal | undefined): boolean {
  return signal?.reason instanceof Error && signal.reason.message === 'skill-download-grant-expired'
}

export function createSkillDownloadAvailabilitySignal(input: {
  signal?: AbortSignal
  now: () => number
  expiresAt: number
}): {
  signal: AbortSignal
  cleanup(): void
} {
  const controller = new AbortController()
  const abortFromCaller = (): void => controller.abort(input.signal?.reason)
  if (input.signal?.aborted) {
    abortFromCaller()
  } else {
    input.signal?.addEventListener('abort', abortFromCaller, { once: true })
  }
  const timeout = setTimeout(
    () => controller.abort(new Error('skill-download-grant-expired')),
    Math.min(MAX_TIMEOUT_DELAY_MS, Math.max(0, input.expiresAt - input.now()))
  )
  timeout.unref()
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout)
      input.signal?.removeEventListener('abort', abortFromCaller)
    }
  }
}
