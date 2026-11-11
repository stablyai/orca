import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { join } from 'node:path'
import { delegateHostValidation } from '../host-validation-budget.mjs'

const lateAdmission = process.argv.includes('--late-admission')
if (lateAdmission) {
  let firstRead = true
  Object.defineProperty(performance, 'now', {
    value: () => {
      const time = firstRead ? 0 : 1000
      firstRead = false
      return time
    }
  })
}

if (!(await delegateHostValidation({ waitTimeoutMs: lateAdmission ? 1 : null }))) {
  if (process.argv.includes('--complete') || lateAdmission) {
    console.log(lateAdmission ? 'admitted-late' : 'nested-complete')
  } else {
    const child = spawn(
      process.execPath,
      [
        join(import.meta.dirname, 'validation-descendant.mjs'),
        ...(process.argv.includes('--cleanup-on-cancel')
          ? [join(process.cwd(), 'cleanup-marker')]
          : [])
      ],
      {
        stdio: ['ignore', 'pipe', 'ignore']
      }
    )
    await once(child.stdout, 'data')
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
