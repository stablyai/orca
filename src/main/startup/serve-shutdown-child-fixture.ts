import { open } from 'node:fs/promises'
import { registerServeSignalHandlers } from './serve-signal-handlers'

const destination = process.argv[2]
if (!destination || !process.send) {
  throw new Error('Shutdown fixture requires a destination and IPC')
}
let quitting = false
const keepAlive = setInterval(() => {}, 1000)
process.send('fixture:starting')
setTimeout(() => {
  registerServeSignalHandlers(process, () => {
    if (quitting) {
      return
    }
    quitting = true
    void (async () => {
      await new Promise((resolve) => setTimeout(resolve, 100))
      const file = await open(destination, 'wx')
      try {
        await file.writeFile('shutdown-drained')
        await file.sync()
      } finally {
        await file.close()
      }
      clearInterval(keepAlive)
      process.disconnect?.()
    })().catch((error: unknown) => {
      console.error(error)
      process.exit(1)
    })
  })
}, 100)
