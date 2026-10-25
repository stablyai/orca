// ELECTRON_RUN_AS_NODE entry: imports must stay transitively Electron-free.
import { createPluginWorkerRuntime } from './plugin-host-runtime'
import type { PluginWorkerChildMessage } from '../../shared/plugins/plugin-host-protocol'

function sendToParent(message: PluginWorkerChildMessage): void {
  process.send?.(message)
}

const runtime = createPluginWorkerRuntime({ send: sendToParent })

process.on('message', (raw: unknown) => {
  void runtime.handleMessage(raw)
})

// Escaped third-party errors must terminate the worker so supervision can restart it.
function dieFatally(error: unknown): void {
  try {
    sendToParent({
      type: 'fatal',
      error: error instanceof Error ? (error.stack ?? error.message) : String(error)
    })
  } catch {
    // Channel already gone; nothing left to report to.
  }
  process.exit(1)
}

process.on('uncaughtException', dieFatally)
process.on('unhandledRejection', dieFatally)

// Parent death closes IPC; exit rather than retain an orphan worker.
process.on('disconnect', () => {
  process.exit(0)
})
