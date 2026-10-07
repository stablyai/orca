import type { PreloadApi } from '../api-types'
import { ptySessionControlApi } from './pty-bridge-session-control'
import { ptyStreamAndSerializationApi } from './pty-bridge-stream-and-serialization'
import { ptyModelCheckpointApi } from './pty-bridge-model-checkpoint'

export const ptyApi = {
  ...ptySessionControlApi,
  ...ptyModelCheckpointApi,
  ...ptyStreamAndSerializationApi
} satisfies PreloadApi['pty']
