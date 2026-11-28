import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, expect, it, vi } from 'vitest'
import { getPiBackgroundWorkBridgeSource } from './rpc-background-work-bridge-source'

const folder = mkdtempSync(join(tmpdir(), 'orca-pi-bridge-'))
afterAll(() => rmSync(folder, { recursive: true, force: true }))

async function reloadCommand() {
  const file = join(folder, 'bridge.mjs')
  writeFileSync(file, getPiBackgroundWorkBridgeSource())
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>()
  const { default: bridge } = await import(pathToFileURL(file).href)
  bridge({
    on: () => {},
    registerCommand: (name: string, command: never) => commands.set(name, command)
  })
  return commands.get('reload')!
}

it('reloads an idle chat and refuses while a turn runs', async () => {
  const command = await reloadCommand()
  const reload = vi.fn(async () => {})
  const notify = vi.fn()

  await command.handler('', { isIdle: () => false, reload, ui: { notify } })
  expect(reload).not.toHaveBeenCalled()
  expect(notify).toHaveBeenLastCalledWith(expect.stringContaining('Wait'), 'warning')

  await command.handler('', { isIdle: () => true, reload, ui: { notify } })
  expect(reload).toHaveBeenCalledTimes(1)
})
