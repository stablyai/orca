import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { serveValidationLease } from './host-validation-budget.mjs'

const stopGroup = () => process.kill(-process.pid, 'SIGKILL')
let stopping = false
const cancelGroup = () => {
  if (stopping) {
    return
  }
  stopping = true
  console.error('[validation] canceling; waiting for process-group cleanup (10s grace)')
  setTimeout(stopGroup, 10_000)
  process.kill(-process.pid, 'SIGINT')
}
process.on('disconnect', cancelGroup)
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, cancelGroup)
}

process.on('message', (message, server) => {
  if (message?.type === 'cancel') {
    cancelGroup()
  }
  if (message?.type !== 'start') {
    return
  }
  serveValidationLease(server, process.env.ORCA_VALIDATION_TOKEN)
  const child = spawn(
    process.execPath,
    [
      '--import',
      fileURLToPath(new URL('./validation-entry-guard.mjs', import.meta.url)),
      message.entry,
      ...message.args
    ],
    {
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      env: { ...process.env, ORCA_VALIDATION_GROUP: String(process.pid) }
    }
  )
  let finished = false
  const finish = (code) => {
    if (finished) {
      return
    }
    finished = true
    if (stopping) {
      if (process.connected) {
        process.send({ type: 'result', code }, () => {})
      }
      return
    }
    if (!process.connected) {
      stopGroup()
    }
    process.send({ type: 'result', code }, stopGroup)
  }
  child.on('error', () => finish(1))
  child.on('close', (code) => finish(code ?? 1))
  child.send({ type: 'lease' }, server, (error) => {
    if (error) {
      finish(1)
    }
  })
})
