import { backendUsageTransport } from '../backend-port-client'
import { createUsageProviderApi } from '../usage-provider-api'
import type { PreloadApi } from '../api-types'

export const codexUsageApi = createUsageProviderApi(
  backendUsageTransport,
  'codexUsage'
) satisfies PreloadApi['codexUsage']
