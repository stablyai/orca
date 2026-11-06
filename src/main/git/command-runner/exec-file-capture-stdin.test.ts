import { describe, expect, it } from 'vitest'
import { execFileCapture, execFileCaptureToTermination } from './exec-file-capture'

const readStdin = [
  '-e',
  'process.stdin.setEncoding("utf8"); let input = ""; process.stdin.on("data", chunk => { input += chunk }); process.stdin.on("end", () => { process.stdout.write(JSON.stringify({ input })) })'
]

describe.each([
  ['ordinary capture', execFileCapture],
  ['termination barrier', execFileCaptureToTermination]
] as const)('%s stdin', (_name, capture) => {
  it('finishes a command that reads stdin to EOF when no input was provided', async () => {
    const result = await capture(process.execPath, readStdin, {
      encoding: 'utf8',
      timeout: 3_000
    })

    expect(result).toEqual({ stdout: JSON.stringify({ input: '' }), stderr: '' })
  })

  it.each(['', 'commit message\nλ\n'.repeat(10_000)])(
    'delivers explicit stdin completely before EOF (%#)',
    async (input) => {
      const result = await capture(process.execPath, readStdin, {
        encoding: 'utf8',
        stdin: input,
        timeout: 3_000
      })

      expect(result).toEqual({ stdout: JSON.stringify({ input }), stderr: '' })
    }
  )
})
