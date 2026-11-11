import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { delegateHostValidation } from '../host-validation-budget.mjs'

if (!(await delegateHostValidation())) {
  if (process.argv.includes('--complete')) {
    console.log('nested-complete')
  } else {
    const child = spawn(
      process.execPath,
      ['-e', "process.on('SIGINT', () => {}); setInterval(() => {}, 1000)"],
      {
        stdio: 'ignore'
      }
    )
    console.log(
      JSON.stringify({
        event: 'running',
        pid: process.pid,
        group: Number(process.env.ORCA_VALIDATION_GROUP),
        child: child.pid
      })
    )
    const input = createInterface({ input: process.stdin })
    if (!process.argv.includes('--ignore-cancel')) {
      process.on('SIGINT', () => process.exit(130))
    }
    for await (const line of input) {
      if (line === 'nested') {
        const nested = spawn(process.execPath, [import.meta.filename, '--complete'], {
          stdio: ['ignore', 'inherit', 'inherit']
        })
        await new Promise((resolve) => nested.once('close', resolve))
        console.log('nested-finished')
      } else {
        process.exit(Number(line))
      }
    }
  }
}
