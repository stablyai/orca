import { expect, it } from 'vitest'
import {
  agyTerminalIsForeign,
  bindAgyTerminalAuthority,
  forgetAgyTerminalAuthority,
  noteAgyTerminalAuthority
} from './agy-terminal-authority'

const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'
// No HOME: agy there reads a login no saved account names, whatever the host's own is.
const foreignSpawn = (): void => noteAgyTerminalAuthority(PANE, {}, ['HOME'])

it("forgets a pane's answer when its terminal exits", async () => {
  foreignSpawn()
  bindAgyTerminalAuthority(PANE, 'pty-1')
  expect(await agyTerminalIsForeign(PANE)).toBe(true)

  forgetAgyTerminalAuthority('pty-1')

  expect(await agyTerminalIsForeign(PANE)).toBe(false)
})

it("keeps a restart's answer when the terminal it replaced exits after the new spawn", async () => {
  noteAgyTerminalAuthority(PANE, process.env)
  bindAgyTerminalAuthority(PANE, 'pty-old')
  foreignSpawn()

  forgetAgyTerminalAuthority('pty-old')
  expect(await agyTerminalIsForeign(PANE)).toBe(true)

  bindAgyTerminalAuthority(PANE, 'pty-new')
  forgetAgyTerminalAuthority('pty-new')
  expect(await agyTerminalIsForeign(PANE)).toBe(false)
})
