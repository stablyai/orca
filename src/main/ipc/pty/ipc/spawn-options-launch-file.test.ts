import { describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { buildPtyIpcSpawnOptions } from './spawn-options'
import { launchPromptShownForPane } from '../../../agent-hooks/launch-file-prompt-by-pane'
import { buildLaunchFilePointer } from '../../../../shared/launch-prompt-file'
import { createPtyIpcSpawnState } from './spawn-state'
import type { PtySpawnIpcArgs, PtySpawnIpcDeps } from './spawn-types'

const LAUNCH_FILE = {
  placeholder: `orca-launch-file-${'a'.repeat(32)}`,
  content: 'the whole task'
}

async function spawnOptionsFor(
  args: PtySpawnIpcArgs,
  typedCommand: string | undefined,
  paneKey?: string
) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: buildPtyIpcSpawnOptions only reads the members stubbed here; the rest belong to later spawn stages this test never runs.
  const deps = {
    transitionSpawnHiddenRendererPtyDeliveryState: vi.fn(),
    syncPtyBackgroundedDelivery: vi.fn(),
    sendPtySpawnedToRenderer: vi.fn(),
    getSettings: () => getDefaultSettings('/tmp'),
    runtime: { registerPreAllocatedHandleForPty: vi.fn() }
  } as unknown as PtySpawnIpcDeps
  const ctx = createPtyIpcSpawnState(deps, args)
  ctx.env = {}
  ctx.launchCommand = typedCommand
  ctx.reservationPaneKey = paneKey ?? null
  await buildPtyIpcSpawnOptions(ctx)
  return ctx.spawnOptions
}

describe('renderer pty spawn: launch file', () => {
  const command = `claude 'The full task is in the file \`${LAUNCH_FILE.placeholder}\`.'`

  it('hands the provider the launch file its command names', async () => {
    const options = await spawnOptionsFor(
      { cols: 80, rows: 24, command, launchFile: LAUNCH_FILE },
      command
    )
    expect(options.launchFile).toEqual(LAUNCH_FILE)
  })

  it('drops a launch file whose placeholder Orca did not mint', async () => {
    const options = await spawnOptionsFor(
      { cols: 80, rows: 24, command, launchFile: { ...LAUNCH_FILE, placeholder: '../../etc' } },
      command
    )
    expect(options.launchFile).toBeUndefined()
  })

  it('drops the launch file when main types a different line, such as a resume', async () => {
    const options = await spawnOptionsFor(
      { cols: 80, rows: 24, command, launchFile: LAUNCH_FILE },
      'codex resume abc'
    )
    expect(options.launchFile).toBeUndefined()
  })

  // Why: the agent's hook reports only the pointer; Orca shows the prompt it points at instead.
  it('shows the prompt a launch file carries for its pane', async () => {
    await spawnOptionsFor(
      { cols: 80, rows: 24, command, launchFile: LAUNCH_FILE },
      command,
      'tab-a:leaf-a'
    )
    const pointer = buildLaunchFilePointer('/tmp/orca-launch-file-a1/task-context.md')
    expect(launchPromptShownForPane('tab-a:leaf-a', pointer)).toBe('the whole task')
    expect(launchPromptShownForPane('tab-b:leaf-b', pointer)).toBe(pointer)
    expect(launchPromptShownForPane('tab-a:leaf-a', 'a later prompt')).toBe('a later prompt')
  })
})

describe('renderer pty spawn: a line the host cannot stage', () => {
  const command = "claude 'a long prompt'"

  it('keeps the caller’s wish with its own command, and drops it for another line or value', async () => {
    const refuse = { cols: 80, rows: 24, command, unstageableLine: 'refuse' }
    expect((await spawnOptionsFor(refuse, command)).unstageableLine).toBe('refuse')
    expect((await spawnOptionsFor(refuse, 'codex resume abc')).unstageableLine).toBeUndefined()
    expect(
      (await spawnOptionsFor({ ...refuse, unstageableLine: 'paste' }, command)).unstageableLine
    ).toBeUndefined()
  })
})
