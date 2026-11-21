import { ipcMain } from 'electron'
import { expect } from 'vitest'

export function invokeGuestDiscard(sender: Electron.WebContents, args: unknown): boolean {
  let reply: boolean | undefined
  let writes = 0
  const event = Object.defineProperty({ sender }, 'returnValue', {
    get: () => undefined,
    set: (value: boolean) => {
      if (writes++ === 0) {
        reply = value
      }
    }
  })
  ipcMain.emit('browser:reserveGuestDiscard', event, args)
  expect(writes).toBe(1)
  if (reply === undefined) {
    throw new Error('Missing synchronous guest discard reply')
  }
  return reply
}
