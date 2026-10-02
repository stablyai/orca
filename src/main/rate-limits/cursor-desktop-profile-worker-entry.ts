import { parentPort } from 'node:worker_threads'
import { readCursorDesktopProfile } from './cursor-desktop-state-db'
import type {
  CursorDesktopProfileRequest,
  CursorDesktopProfileResponse
} from './cursor-desktop-profile-worker'

const port = parentPort
if (!port) {
  throw new Error('Cursor desktop login worker requires a parent port')
}

port.on('message', ({ id, dbPath }: CursorDesktopProfileRequest) => {
  const response: CursorDesktopProfileResponse = {
    id,
    result: readCursorDesktopProfile(dbPath)
  }
  port.postMessage(response)
})
