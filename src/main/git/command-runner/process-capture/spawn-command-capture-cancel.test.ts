import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

it('survives cancellation before a queued native spawn error is delivered', async () => {
  // A separate Node process makes an uncaught late error fail this case instead of the test worker.
  const moduleUrl = new URL('./spawn-command-capture.ts', import.meta.url).href
  const script = `
    import { randomUUID } from 'node:crypto'
    import { tmpdir } from 'node:os'
    import { join } from 'node:path'
    import { spawnCommandCapture } from ${JSON.stringify(moduleUrl)}
    const controller = new AbortController()
    const result = spawnCommandCapture(process.execPath, ['-e', ''], {
      cwd: join(tmpdir(), randomUUID()),
      signal: controller.signal
    }).catch(error => error.name)
    controller.abort()
    process.stdout.write(await result)
  `
  const { stdout } = await promisify(execFile)(process.execPath, [
    '--import',
    'tsx',
    '--input-type=module',
    '-e',
    script
  ])
  expect(stdout).toBe('AbortError')
})
