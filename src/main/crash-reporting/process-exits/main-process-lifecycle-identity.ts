import { randomUUID } from 'node:crypto'

export type MainProcessLifecycleIdentity = Readonly<{
  mainProcessPid: number
  mainProcessLaunchId: string
  mainProcessStartedAt: string
}>

// Reloads share this identity; relaunches need a new ID even if the OS recycles the PID.
const mainProcessLifecycleIdentity: MainProcessLifecycleIdentity = Object.freeze({
  mainProcessPid: process.pid,
  mainProcessLaunchId: randomUUID(),
  mainProcessStartedAt: new Date(Date.now() - process.uptime() * 1_000).toISOString()
})

export function getMainProcessLifecycleIdentity(): MainProcessLifecycleIdentity {
  return mainProcessLifecycleIdentity
}
