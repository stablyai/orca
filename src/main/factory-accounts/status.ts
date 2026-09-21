import type { FactoryAccountStatus } from '../../shared/rate-limit-types'
import { resolveFactoryApiKey } from '../rate-limits/factory-auth'

export function getFactoryAccountStatus(): FactoryAccountStatus {
  const readResult = resolveFactoryApiKey()
  if (readResult.status === 'missing') {
    return { configured: false, source: null, error: null }
  }
  if (readResult.status === 'error') {
    return { configured: false, source: null, error: readResult.error }
  }
  return { configured: true, source: readResult.source, error: null }
}
