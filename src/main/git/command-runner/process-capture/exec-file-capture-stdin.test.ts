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
})

it('delivers non-UTF8 image bytes unchanged through the termination barrier', async () => {
  const result = await execFileCaptureToTermination(
    process.execPath,
    [
      '-e',
      'const chunks = []; process.stdin.on("data", c => chunks.push(c)); process.stdin.on("end", () => process.stdout.write(Buffer.concat(chunks).toString("hex")))'
    ],
    {
      encoding: 'utf8',
      timeout: 3_000,
      stdin: new Uint8Array([0, 128, 255])
    }
  )
  expect(result).toEqual({ stdout: '0080ff', stderr: '' })
})
