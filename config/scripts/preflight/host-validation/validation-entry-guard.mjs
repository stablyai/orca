import { serveValidationLease } from './host-validation-budget.mjs'

const group = Number(process.env.ORCA_VALIDATION_GROUP)
if (!Number.isSafeInteger(group) || group <= 1 || !process.channel) {
  throw new Error('Validation entry guard requires its supervising process group and IPC channel')
}
const stopGroup = () => process.kill(-group, 'SIGKILL')
process.on('disconnect', stopGroup)
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {})
}
await new Promise((resolve) => {
  process.once('message', (message, server) => {
    if (message?.type !== 'lease' || !server) {
      stopGroup()
    }
    serveValidationLease(server, process.env.ORCA_VALIDATION_TOKEN)
    server.unref()
    process.channel.unref()
    resolve()
  })
})
