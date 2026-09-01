import type { PreloadApi } from '../api-types'
import { uiApiPart1 } from './ui-bridge-part-1'
import { uiApiPart2 } from './ui-bridge-part-2'
import { uiApiPart3 } from './ui-bridge-part-3'
import { uiApiPart4 } from './ui-bridge-part-4'
import { uiApiPart5 } from './ui-bridge-part-5'

export const uiApi = {
  ...uiApiPart1,
  ...uiApiPart2,
  ...uiApiPart3,
  ...uiApiPart4,
  ...uiApiPart5
} satisfies PreloadApi['ui']
