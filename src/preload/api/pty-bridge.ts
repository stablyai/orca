import { ptySessionControlApi } from './pty-bridge-session-control'
import { ptyStreamAndSerializationApi } from './pty-bridge-stream-and-serialization'

export const ptyApi = { ...ptySessionControlApi, ...ptyStreamAndSerializationApi }
