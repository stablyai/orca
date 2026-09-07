import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  captureCodexTurnProcesses,
  terminateCodexTurnProcesses
} from './codex-structured-turn-processes'

function nextLine(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8')
      const newline = buffer.indexOf('\n')
      if (newline === -1) {
        return
      }
      child.stdout.off('data', onData)
      resolve(buffer.slice(0, newline))
    }
    child.once('error', reject)
    child.stdout.on('data', onData)
  })
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe.runIf(process.platform !== 'win32')('Codex structured turn process termination', () => {
  it('removes the exact PID of a stopped 60-second command', async () => {
    const root = spawn(
      process.execPath,
      [
        '-e',
        `const { spawn } = require('node:child_process');
         process.stdin.once('data', () => {
           const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
           process.stdout.write(String(child.pid) + '\\n');
         });
         setTimeout(() => {}, 60000);`
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    )
    let commandPid = 0
    try {
      const baseline = await captureCodexTurnProcesses(root.pid!)
      root.stdin.write('start\n')
      commandPid = Number(await nextLine(root))
      expect(processExists(commandPid)).toBe(true)

      await expect(terminateCodexTurnProcesses(root.pid!, baseline)).resolves.toBe(true)
      expect(processExists(commandPid)).toBe(false)
    } finally {
      if (commandPid > 0 && processExists(commandPid)) {
        process.kill(commandPid, 'SIGKILL')
      }
      root.kill('SIGKILL')
    }
  }, 15_000)

  it('preserves descendants that predate the turn', async () => {
    const root = spawn(
      process.execPath,
      [
        '-e',
        `const { spawn } = require('node:child_process');
         const persistent = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
         process.stdout.write(String(persistent.pid) + '\\n');
         process.stdin.once('data', () => {
           const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
           process.stdout.write(String(child.pid) + '\\n');
         });
         setTimeout(() => {}, 60000);`
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    )
    let persistentPid = 0
    let commandPid = 0
    try {
      persistentPid = Number(await nextLine(root))
      const baseline = await captureCodexTurnProcesses(root.pid!)
      root.stdin.write('start\n')
      commandPid = Number(await nextLine(root))

      await expect(terminateCodexTurnProcesses(root.pid!, baseline)).resolves.toBe(true)
      expect(processExists(persistentPid)).toBe(true)
      expect(processExists(commandPid)).toBe(false)
    } finally {
      if (persistentPid > 0 && processExists(persistentPid)) {
        process.kill(persistentPid, 'SIGKILL')
      }
      if (commandPid > 0 && processExists(commandPid)) {
        process.kill(commandPid, 'SIGKILL')
      }
      root.kill('SIGKILL')
    }
  }, 15_000)
})
