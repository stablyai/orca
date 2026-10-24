import { PassThrough } from 'node:stream'
import { expect, it, vi } from 'vitest'
import { parseReclaimArguments, runReclaimCommand } from './reclaim-worktree-command.mjs'

function terminal(answer, tty = true) {
  const input = new PassThrough()
  const output = new PassThrough()
  input.isTTY = tty
  output.isTTY = tty
  let text = ''
  output.on('data', (chunk) => {
    text += chunk.toString()
    if (chunk.toString().includes('[y/N]')) {
      input.write(`${answer}\n`)
    }
  })
  return { input, output, text: () => text }
}

it.each(['Y', 'y', 'yes', ' YES '])(
  'applies after preview when the user answers %j',
  async (answer) => {
    const streams = terminal(answer)
    const reclaim = vi.fn().mockResolvedValue({ completed: true })
    await runReclaimCommand(['--tests-stopped', '--release-cache-min-age-days', '7'], {
      ...streams,
      reclaim
    })
    expect(reclaim.mock.calls.map(([options]) => options.apply)).toEqual([false, true])
    expect(reclaim.mock.calls[1][0]).toMatchObject({
      testsStopped: true,
      releaseCacheMinAgeDays: 7
    })
  }
)

it.each(['', 'n', 'no', 'sure'])('leaves files alone after preview on %j', async (answer) => {
  const streams = terminal(answer)
  const reclaim = vi.fn().mockResolvedValue({ completed: true })
  await runReclaimCommand([], { ...streams, reclaim })
  expect(reclaim).toHaveBeenCalledTimes(1)
  expect(reclaim.mock.calls[0][0].apply).toBe(false)
})

it.each(['--apply', '--automatic'])('never prompts with %s', async (flag) => {
  const streams = terminal('Y')
  const reclaim = vi.fn().mockResolvedValue({ completed: true })
  await runReclaimCommand([flag], { ...streams, reclaim })
  expect(reclaim).toHaveBeenCalledTimes(1)
  expect(streams.text()).not.toContain('[y/N]')
})

it('does not interpret piped input as approval', async () => {
  const streams = terminal('Y', false)
  streams.input.write('Y\n')
  const reclaim = vi.fn().mockResolvedValue({ completed: true })
  await runReclaimCommand([], { ...streams, reclaim })
  expect(reclaim).toHaveBeenCalledTimes(1)
  expect(reclaim.mock.calls[0][0].apply).toBe(false)
  expect(streams.text()).not.toContain('[y/N]')
})

it('does not offer to apply a failed preview', async () => {
  const streams = terminal('Y')
  const reclaim = vi.fn().mockRejectedValue(new Error('preview failed'))
  await expect(runReclaimCommand([], { ...streams, reclaim })).rejects.toThrow('preview failed')
  expect(streams.text()).not.toContain('[y/N]')
})

it.each([
  ['--repo'],
  ['--repo', '--apply'],
  ['--exclude-worktree'],
  ['--release-cache-min-age-days'],
  ['--release-cache-min-age-days', 'NaN'],
  ['--release-cache-min-age-days', '-1'],
  ['--unknown']
])('rejects invalid flags before any sweep: %j', (...args) => {
  expect(() => parseReclaimArguments(args)).toThrow()
})

it('shows the single command without starting cleanup for help', async () => {
  const streams = terminal('Y')
  const reclaim = vi.fn()
  await runReclaimCommand(['--help'], { ...streams, reclaim })
  expect(streams.text()).toContain('pnpm reclaim-space')
  expect(reclaim).not.toHaveBeenCalled()
})
