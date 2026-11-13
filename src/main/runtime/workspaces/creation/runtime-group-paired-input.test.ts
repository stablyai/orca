import { expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareGroupFolderCreation } from './runtime-group-folder-setup'
import { fixture } from './runtime-group-paired-input.fixture'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
vi.mock('../startup/workspace-terminal-provisioning', () => ({
  OrcaRuntimeWithGetWorktreeTerminalProvisioningHost: class {}
}))
vi.mock('../../terminal/input/terminal-agent-prompt-render', () => ({
  OrcaRuntimeWithCreateAgentPromptRenderGate: class {}
}))

const codexStartup = readFileSync(
  join(__dirname, '../../__fixtures__/codex-fullscreen-startup.txt'),
  'utf8'
)
const liveFooter = codexStartup.indexOf('GPT-6.1-Sol')

it.each([
  ['native Windows', true, 'pwsh'],
  ['Windows-host WSL', false, null]
] as const)(
  'submits once after delayed real composer output on %s',
  async (_host, native, name) => {
    vi.useFakeTimers()
    const f = fixture(false, true, 'auto-submit', native)
    f.ordinaryForeground(name)
    await prepareGroupFolderCreation(f.args)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(f.write).not.toHaveBeenCalled()
    f.finish(0)
    await vi.advanceTimersByTimeAsync(0)
    f.output(codexStartup.slice(0, liveFooter))
    await vi.advanceTimersByTimeAsync(6_000)
    expect(f.write).not.toHaveBeenCalled()
    f.output(codexStartup.slice(liveFooter))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.write.mock.calls).toEqual(
      native
        ? [
            ['agent-pty', 'Inspect the linked task', 'launch'],
            ['agent-pty', '\r', 'launch']
          ]
        : [['agent-pty', 'Inspect the linked task\r', 'launch']]
    )
    f.ready()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.write).toHaveBeenCalledTimes(native ? 2 : 1)
  }
)

it.each([true, false])('refuses a target replaced after readiness (native=%s)', async (native) => {
  vi.useFakeTimers()
  const f = fixture(false, true, 'auto-submit', native)
  f.ordinaryForeground(null)
  await prepareGroupFolderCreation(f.args)
  f.replaceAfterReady()
  f.finish(0)
  await vi.advanceTimersByTimeAsync(0)
  f.output(codexStartup)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(f.write).not.toHaveBeenCalled()
})

it('refuses native input when the target changes during the final foreground read', async () => {
  vi.useFakeTimers()
  const f = fixture(false, true, 'auto-submit', true)
  await prepareGroupFolderCreation(f.args)
  f.replaceAfterForeground()
  f.finish(0)
  await vi.advanceTimersByTimeAsync(0)
  f.output(codexStartup)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(f.write).not.toHaveBeenCalled()
})

it.each(['provisional', 'shell', 'dialog'] as const)(
  'does not send after %s readiness expires',
  async (state) => {
    vi.useFakeTimers()
    const f = fixture(false, true, 'auto-submit', true)
    f.ordinaryForeground(null)
    await prepareGroupFolderCreation(f.args)
    if (state === 'shell') {
      f.shell()
    }
    f.finish(0)
    await vi.advanceTimersByTimeAsync(0)
    f.output(
      state === 'dialog'
        ? 'Trust this folder? [y/n]'
        : state === 'provisional'
          ? codexStartup.slice(0, liveFooter)
          : codexStartup
    )
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.write).not.toHaveBeenCalled()
    f.output(codexStartup)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.write).not.toHaveBeenCalled()
  }
)

it('returns creation before slow required Setup and starts real draft readiness only after observed success', async () => {
  vi.useFakeTimers()
  const f = fixture()
  const result = await prepareGroupFolderCreation(f.args)
  expect(result.startupTerminal?.tabId).toBe('agent-tab')
  await vi.advanceTimersByTimeAsync(30_000)
  expect(f.write).not.toHaveBeenCalled()
  f.finish(0)
  await vi.advanceTimersByTimeAsync(0)
  f.ready()
  await vi.advanceTimersByTimeAsync(0)
  expect(f.write).toHaveBeenCalledExactlyOnceWith(
    'agent-pty',
    '\x1b[200~Inspect the linked task\x1b[201~',
    'launch'
  )
  expect(f.args.buildStartup).not.toHaveBeenCalled()
  expect(f.createTerminal.mock.calls[0]?.[1]).toMatchObject({
    env: expect.objectContaining({ CUSTOM: 'preserved' })
  })
})

it('replays fast Setup completion without losing the unsent draft', async () => {
  vi.useFakeTimers()
  const f = fixture(true)
  await prepareGroupFolderCreation(f.args)
  await vi.advanceTimersByTimeAsync(0)
  f.ready()
  await vi.advanceTimersByTimeAsync(0)
  expect(f.write).toHaveBeenCalledExactlyOnceWith(
    'agent-pty',
    '\x1b[200~Inspect the linked task\x1b[201~',
    'launch'
  )
})

it.each([
  ['draft', '\x1b[200~Inspect the linked task\x1b[201~'],
  ['auto-submit', 'Inspect the linked task\r']
] as const)('delivers %s once on a ready Windows-hosted WSL pane', async (delivery, expected) => {
  vi.useFakeTimers()
  const f = fixture(false, true, delivery)
  await prepareGroupFolderCreation(f.args)
  expect(f.write).not.toHaveBeenCalled()
  f.finish(0)
  await vi.advanceTimersByTimeAsync(0)
  f.ready()
  await vi.advanceTimersByTimeAsync(0)
  expect(f.write).toHaveBeenCalledExactlyOnceWith('agent-pty', expected, 'launch')
})

it('refuses a replaced Windows-hosted WSL target before typed followup', async () => {
  vi.useFakeTimers()
  const f = fixture(false, true, 'auto-submit')
  await prepareGroupFolderCreation(f.args)
  f.replace()
  f.finish(0)
  await vi.advanceTimersByTimeAsync(60_000)
  f.ready()
  await vi.advanceTimersByTimeAsync(0)
  expect(f.write).not.toHaveBeenCalled()
})

it.each(['failed setup', 'replaced agent'] as const)(
  'never writes pending text after %s',
  async (failure) => {
    vi.useFakeTimers()
    const f = fixture()
    await prepareGroupFolderCreation(f.args)
    f.finish(failure === 'failed setup' ? 1 : 0)
    await vi.advanceTimersByTimeAsync(0)
    if (failure === 'replaced agent') {
      f.replace()
    }
    f.ready()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(f.write).not.toHaveBeenCalled()
  }
)

it('refuses a proven shell after stale WSL draft readiness', async () => {
  vi.useFakeTimers()
  const f = fixture(false, true)
  await prepareGroupFolderCreation(f.args)
  f.shell()
  f.finish(0)
  await vi.advanceTimersByTimeAsync(0)
  f.ready()
  await vi.advanceTimersByTimeAsync(0)
  expect(f.write).not.toHaveBeenCalled()
})
