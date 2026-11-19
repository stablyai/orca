import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { spawnProcess } from '@orca/process-host'
import { describe, expect, it } from 'vitest'
import { inspectDaemonProcessIdentity } from '../endpoint/identity/daemon-pid-identity'

const namingModule = new URL('../daemon-process-name.ts', import.meta.url)

describe.skipIf(process.platform !== 'linux')('Linux daemon process naming', () => {
  it.each([false, true])(
    'preserves live daemon identity when naming writes are denied: %s',
    async (denyWrites) => {
      const socketPath = '/tmp/orca naming contract/daemon.sock'
      const tokenPath = `/tmp/orca naming contract/${'long endpoint component/'.repeat(12)}daemon.token`
      const script = `
        import { readFileSync } from 'node:fs'
        import { setDaemonProcessName } from ${JSON.stringify(namingModule.href)}
        const before = readFileSync('/proc/self/cmdline').toString('base64')
        const beforeName = readFileSync('/proc/self/comm').toString('base64')
        setDaemonProcessName()
        process.stdin.resume()
        console.log([
          before,
          readFileSync('/proc/self/cmdline').toString('base64'),
          beforeName,
          readFileSync('/proc/self/comm').toString('base64')
        ].join(' '))
      `
      const child = spawnProcess({
        program: process.env.ORCA_TEST_NODE_EXECUTABLE ?? process.execPath,
        args: [
          ...(denyWrites ? ['--permission', '--allow-fs-read=*'] : []),
          '--input-type=module',
          '-e',
          script,
          '--',
          'daemon-entry.js',
          '--socket',
          socketPath,
          '--token',
          tokenPath
        ]
      })
      const exited = once(child, 'exit')
      const lines = createInterface({ input: child.stdout })
      try {
        const [line] = await Promise.race([
          once(lines, 'line'),
          exited.then(() => {
            throw new Error('Naming fixture exited before publishing its process identity')
          })
        ])
        const [before, after, beforeName, afterName] = String(line).split(' ')
        expect(Buffer.from(before, 'base64').toString()).toContain(tokenPath)
        expect(after).toBe(before)
        expect(Buffer.from(afterName, 'base64').toString()).toBe(
          denyWrites ? Buffer.from(beforeName, 'base64').toString() : 'orca-agents\n'
        )
        expect(child.pid).toBeDefined()
        expect(
          await inspectDaemonProcessIdentity(child.pid ?? 0, socketPath, tokenPath, null)
        ).toBe('match')
      } finally {
        lines.close()
        child.stdin.end()
        await exited
      }
    }
  )
})
