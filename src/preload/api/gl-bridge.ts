import { glApi } from '../gitlab'
import type { PreloadApi } from '../api-types'

export const glApiBridge = glApi satisfies PreloadApi['gl']
