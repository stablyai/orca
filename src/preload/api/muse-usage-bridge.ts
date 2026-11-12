import { backendUsageTransport } from '../backend-port-client'
import { createUsageProviderApi } from '../usage-provider-api'
import type { PreloadApi } from '../api-types'

export const museUsageApi = createUsageProviderApi(
  backendUsageTransport,
  'museUsage'
) satisfies PreloadApi['museUsage']
