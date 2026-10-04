import { expect, it, vi } from 'vitest'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { readSshFileWithHistoryDecoding } from './ssh-filesystem-decoded-history'

function multiplexer(result: unknown) {
  const request = vi.fn(async () => result)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this path only calls request, and each test asserts its exact arguments.
  const mux = { request } as unknown as SshChannelMultiplexer
  return { request, mux }
}

it('requires a decoded snapshot from the transcript-owning SSH host', async () => {
  const { mux, request } = multiplexer({
    content: '{"format":"reasonix-history"}',
    isBinary: false,
    decodedReasonixHistory: true
  })
  await expect(
    readSshFileWithHistoryDecoding(mux, '/host/events.frames', { decodeReasonixHistory: true })
  ).resolves.toEqual({
    content: '{"format":"reasonix-history"}',
    isBinary: false,
    decodedReasonixHistory: true
  })
  expect(request).toHaveBeenCalledExactlyOnceWith('fs.readFile', {
    filePath: '/host/events.frames',
    decodeReasonixHistory: true
  })
})

it.each([
  undefined,
  { content: 'RX4F', isBinary: true },
  { content: 'raw', isBinary: false },
  { content: 'raw', isBinary: true, decodedReasonixHistory: true }
])(
  'refuses an old or malformed host response without streaming binary bytes: %j',
  async (result) => {
    const { mux, request } = multiplexer(result)
    await expect(
      readSshFileWithHistoryDecoding(mux, '/host/events.frames', { decodeReasonixHistory: true })
    ).rejects.toThrow('newer transcript-owning Orca host')
    expect(request).toHaveBeenCalledTimes(1)
  }
)

it('enforces the client decoded-byte limit as well as the host limit', async () => {
  const { mux } = multiplexer({
    content: 'é'.repeat(1024 * 1024 + 1),
    isBinary: false,
    decodedReasonixHistory: true
  })
  await expect(
    readSshFileWithHistoryDecoding(mux, '/host/events.frames', { decodeReasonixHistory: true })
  ).rejects.toThrow('client read limit')
})
