import { readdirSync, readlinkSync } from 'node:fs'
import { spawnBunPty } from './pty-subprocess/bun-pty-process'

function masterDescriptors(): Set<string> {
  if (process.platform !== 'linux') {
    return new Set()
  }
  return new Set(
    readdirSync('/proc/self/fd').filter((fd) => {
      try {
        return /\/dev\/(?:pts\/)?ptmx$/.test(readlinkSync(`/proc/self/fd/${fd}`))
      } catch {
        return false
      }
    })
  )
}

function shell(command: string, file = '/bin/sh') {
  return spawnBunPty({
    file,
    args: ['-c', command],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', TERM: 'xterm-256color' },
    cols: 80,
    rows: 24
  })
}

export async function exerciseRetiredHandle({ destroy }: { destroy: boolean }) {
  const before = masterDescriptors()
  const retired = shell('read value')
  const retiredDescriptors = [...masterDescriptors()].filter((fd) => !before.has(fd))
  const retiredExit = new Promise<void>((resolve) => retired.onExit(() => resolve()))
  retired.write('done\r')
  await retiredExit
  if (destroy) {
    retired.destroy()
  }

  const live = shell('read value; stty size; printf "__READ:%s__\n" "$value"', '/bin/bash')
  const liveDescriptors = masterDescriptors()
  let output = ''
  live.onData((data) => {
    output += data
  })
  const liveExit = new Promise<number>((resolve) =>
    live.onExit(({ exitCode }) => resolve(exitCode))
  )
  try {
    retired.resize(200, 50)
    retired.write('leak\r')
    const retiredProcess = retired.process
    live.write('hello\r')
    const exitCode = await liveExit
    return {
      retiredSize: [retired.cols, retired.rows],
      retiredProcess,
      output,
      exitCode,
      reusedDescriptor:
        process.platform === 'linux'
          ? retiredDescriptors.some((fd) => liveDescriptors.has(fd))
          : null
    }
  } finally {
    live.destroy()
    retired.destroy()
    await liveExit
  }
}
