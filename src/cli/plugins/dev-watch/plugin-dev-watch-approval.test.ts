import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'

import '../../runtime/connection/types'
import { createTerminalConfirm } from './plugin-dev-watch-approval'

import './plugin-dev-watch-loop'

function terminal(isTTY = true) {
  const input = Object.assign(new PassThrough(), { isTTY })
  const output = Object.assign(new PassThrough(), { isTTY })
  let printed = ''
  output.on('data', (chunk: Buffer) => {
    printed += chunk.toString()
  })
  return { input, output, printed: () => printed }
}

describe('pluginDevWatchConfirmFor', () => {
  it.each([
    ['end of input', (input: PassThrough) => input.end()],
    ['Ctrl-C', (input: PassThrough) => input.write('\u0003')]
  ])('reads %s as no', async (_name, stop) => {
    const streams = terminal()
    const answer = createTerminalConfirm(streams)('Approve and load? [y/N] ')
    stop(streams.input)
    await expect(answer).resolves.toBe(false)
  })
})
