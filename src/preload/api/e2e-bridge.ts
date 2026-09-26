import { preloadE2EConfig } from '../e2e-config'
import type { PreloadApi } from '../api-types'

export const e2eApi = {
  getConfig: () => preloadE2EConfig
} satisfies PreloadApi['e2e']
