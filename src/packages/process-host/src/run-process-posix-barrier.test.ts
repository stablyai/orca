import { expect, it } from 'vitest'
import { runProcess } from './run-process'

it.skipIf(process.platform === 'win32')(
  'keeps a standalone supervisor alive until a TERM-ignoring descendant stops',
  async () => {
    // The grandchild announces its PID, then closes both inherited pipes before the root exits.
    const command = `sh -c 'trap "" TERM; echo $$ >&2; exec >/dev/null 2>&1; exec sleep 30' & wait`
    const supervisor = `
      const { runProcess } = require('./run-process.ts')
      const controller = new AbortController()
      runProcess({
        program: '/bin/sh',
        args: ['-c', ${JSON.stringify(command)}],
        signal: controller.signal,
        terminationBarrier: 'wait-for-posix-group',
        onStderr: () => controller.abort()
      }).then(result => console.log(result.stderr.trim()))
    `
    const result = await runProcess({
      program: process.env.ORCA_TEST_NODE_EXECUTABLE ?? process.execPath,
      args: ['--require', require.resolve('tsx/cjs'), '-e', supervisor],
      cwd: __dirname,
      timeoutMs: 20_000
    })
    expect(result, result.stderr).toMatchObject({ code: 0, timedOut: false })
    expect(result.stdout.trim()).toMatch(/^\d+$/)
    const leaf = await runProcess({
      program: '/bin/ps',
      args: ['-o', 'stat=', '-p', result.stdout.trim()]
    })
    expect([0, 1]).toContain(leaf.code)
    expect(leaf.stderr).toBe('')
    expect(leaf.stdout.trim()).toMatch(/^(?:Z.*)?$/)
  }
)
