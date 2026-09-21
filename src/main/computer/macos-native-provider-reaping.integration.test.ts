import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { spawnProcess, type ChildProcessHandle } from '../../shared/child-process/run-process'
import { reapMacOSProviderProcess } from './macos-native-provider-process-reaping'

describe.skipIf(process.platform === 'win32')('real macOS provider process reaping', () => {
  const children: ChildProcessHandle[] = []

  afterEach(async () => {
    await Promise.all(
      children.splice(0).map(async (child) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          return
        }
        const exit = once(child, 'exit')
        child.kill('SIGKILL')
        await exit
      })
    )
  })

  it.each(['healthy', 'ignores SIGTERM', 'stopped'])('reaps a %s detached child', async (mode) => {
    const child = spawnProcess({
      program: process.execPath,
      args: [
        '-e',
        `
        ${mode === 'ignores SIGTERM' ? "process.on('SIGTERM', () => {});" : ''}
        setInterval(() => {}, 1000);
        process.stdout.write('ready');
      `
      ],
      detached: true
    })
    children.push(child)
    const exited = once(child, 'exit')
    await once(child.stdout, 'data')
    if (mode === 'stopped') {
      child.kill('SIGSTOP')
    }
    const exitListeners = process.listenerCount('exit')

    reapMacOSProviderProcess(child)
    reapMacOSProviderProcess(child)

    const [code, signal] = await exited
    expect(code).toBeNull()
    expect(signal).toBe(mode === 'healthy' ? 'SIGTERM' : 'SIGKILL')
    expect(process.listenerCount('exit')).toBe(exitListeners)
  })
})
