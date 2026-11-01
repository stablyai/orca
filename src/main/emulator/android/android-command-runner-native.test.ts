import { expect, it } from 'vitest'
import { execFileAndroidCommandRunner } from './android-command-runner'

it('preserves argument bytes and returns both output streams and nonzero exits as data', async () => {
  const args = ['space text', 'quote\'"', '$() & | ;', '漢🙂']
  const result = await execFileAndroidCommandRunner(process.execPath, [
    '-e',
    'process.stdout.write(JSON.stringify(process.argv.slice(1))); process.stderr.write("stderr"); process.exitCode=7',
    ...args
  ])
  expect(result).toEqual({ stdout: JSON.stringify(args), stderr: 'stderr', code: 7 })
})

it('fails a command that exceeds its deadline', async () => {
  const result = await execFileAndroidCommandRunner(
    process.execPath,
    ['-e', 'setInterval(()=>{},1000)'],
    { timeoutMs: 500 }
  )
  expect(result).toEqual({ stdout: '', stderr: '', code: 1 })
})
