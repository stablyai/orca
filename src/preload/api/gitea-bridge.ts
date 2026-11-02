import type { PreloadApi } from '../api-types'
import { giteaApi } from '../gitea'

export const giteaApiBridge = giteaApi satisfies PreloadApi['gitea']
