import { expect, it } from 'vitest'
import { runProcess } from './run-process'

it.skipIf(process.platform === 'win32')(
  'finishes a synchronous timeout even when the child ignores SIGTERM',
  async () => {
    const supervisor = `
      const { runProcessSync } = require('./run-process-sync.ts')
      for (const timeoutMs of [undefined, null]) {
        const result = runProcessSync({
          program: process.execPath,
          args: ['-e', 'process.stdout.write("ordinary")'],
          timeoutMs
        })
        console.log(JSON.stringify([result.code, result.timedOut, result.stdout]))
      }
      const result = runProcessSync({
        program: '/bin/sh',
        args: ['-c', 'trap "" TERM; exec sleep 30'],
        timeoutMs: 500
      })
      console.log(JSON.stringify([result.code, result.timedOut, result.signal]))
    `
    const result = await runProcess({
      program: process.env.ORCA_TEST_NODE_EXECUTABLE ?? process.execPath,
      args: ['--require', require.resolve('tsx/cjs'), '-e', supervisor],
      cwd: __dirname,
      timeoutMs: 3000,
      terminationBarrier: 'wait-for-posix-group'
    })
    expect(result, result.stderr).toMatchObject({ code: 0, timedOut: false })
    expect(result.stdout.trim().split('\n')).toEqual([
      '[0,false,"ordinary"]',
      '[0,false,"ordinary"]',
      '[null,true,"SIGKILL"]'
    ])
  }
)
