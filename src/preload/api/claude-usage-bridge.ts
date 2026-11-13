import { backendUsageTransport } from '../usage/backend-port-client'
import { createUsageProviderApi } from '../usage/usage-provider-api'
import type { PreloadApi } from '../api-types'

export const claudeUsageApi = createUsageProviderApi(
  backendUsageTransport,
  'claudeUsage'
) satisfies PreloadApi['claudeUsage']
