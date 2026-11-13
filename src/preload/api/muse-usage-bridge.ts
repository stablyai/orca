import { backendUsageTransport } from '../usage/backend-port-client'
import { createUsageProviderApi } from '../usage/usage-provider-api'
import type { PreloadApi } from '../api-types'

export const museUsageApi = createUsageProviderApi(
  backendUsageTransport,
  'museUsage'
) satisfies PreloadApi['museUsage']
