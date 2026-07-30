import { randomUUID } from 'node:crypto'

export type MainProcessLifecycleIdentity = Readonly<{
  mainProcessPid: number
  mainProcessLaunchId: string
  mainProcessStartedAt: string
}>

// Why: renderer reloads reuse the Electron main process, while true app
// relaunches must receive a new ID even when the OS later recycles its PID.
const mainProcessLifecycleIdentity: MainProcessLifecycleIdentity = Object.freeze({
  mainProcessPid: process.pid,
  mainProcessLaunchId: randomUUID(),
  mainProcessStartedAt: new Date(Date.now() - process.uptime() * 1_000).toISOString()
})

export function getMainProcessLifecycleIdentity(): MainProcessLifecycleIdentity {
  return mainProcessLifecycleIdentity
}
