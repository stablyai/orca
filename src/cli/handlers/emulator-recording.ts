import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import { resolveRepoPathArgument } from '../repo-path-arguments'
import { getOptionalStringFlag } from '../flags'
import { getEmulatorCommandTarget } from '../selectors'

function formatRecordingPath(value: unknown): string {
  const outputPath = (value as { outputPath?: unknown } | null)?.outputPath
  return typeof outputPath === 'string' ? outputPath : 'the emulator recordings folder'
}

export const EMULATOR_RECORDING_HANDLERS: Record<string, CommandHandler> = {
  'emulator record start': async ({ flags, client, cwd, json }) => {
    const target = await getEmulatorCommandTarget(flags, cwd, client)
    const requestedPath = getOptionalStringFlag(flags, 'path')
    const res = await client.call('emulator.recordStart', {
      path: requestedPath
        ? resolveRepoPathArgument(requestedPath, cwd, client.isRemote, 'Remote emulator recording')
        : undefined,
      device: target.device,
      emulator: target.emulator,
      worktree: target.worktree
    })
    printResult(res, json, (r) => `Recording to ${formatRecordingPath(r)}`)
  },
  'emulator record stop': async ({ flags, client, cwd, json }) => {
    const target = await getEmulatorCommandTarget(flags, cwd, client)
    const res = await client.call('emulator.recordStop', {
      device: target.device,
      emulator: target.emulator,
      worktree: target.worktree
    })
    printResult(res, json, (r) => `Saved recording to ${formatRecordingPath(r)}`)
  }
}
