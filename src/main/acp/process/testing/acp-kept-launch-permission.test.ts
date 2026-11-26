import { describe, expect, it } from 'vitest'
import { keptAcpLaunchPermission } from '../acp-kept-launch-permission'

// As Grok: full access is only a launch argument.
const spec = {
  permissionModeConfig: undefined,
  args: ({ fullAccess }: { fullAccess: boolean }) =>
    fullAccess ? ['agent', '--always-approve', 'stdio'] : ['agent', 'stdio']
}
const kept = { reattached: true, child: { pid: 42 } } as const
const ask = { permissionMode: 'ask' as const }
const chat = { fullAccess: false }

describe('kept ACP launch permission', () => {
  it('reports the full access a kept agent was launched with, whatever the chat now says', async () => {
    const granted = await keptAcpLaunchPermission(spec, kept, chat, ask, async () =>
      ['grok', 'agent', '--always-approve', 'stdio'].join('\0')
    )
    expect(granted).toMatchObject({ permission: 'full-access', launchArgsGrantFullAccess: true })
    // A command line that can't be read is treated as granted, never as Ask.
    const unread = await keptAcpLaunchPermission(spec, kept, chat, ask, async () => undefined)
    expect(unread).toMatchObject({ permission: 'full-access', launchArgsGrantFullAccess: true })
    const plain = await keptAcpLaunchPermission(
      spec,
      kept,
      chat,
      ask,
      async () => 'grok agent stdio'
    )
    expect(plain).toMatchObject({ permission: 'ask', launchArgsGrantFullAccess: false })
  })

  it("reads the spawning app's note instead of the process table", async () => {
    const noted = (note: string) => ({
      reattached: true,
      child: { pid: 42, attachResult: { launchNote: note } }
    })
    const read = async () => {
      throw new Error('no command line read')
    }
    const granted = await keptAcpLaunchPermission(spec, noted('full-access'), chat, ask, read)
    expect(granted).toMatchObject({ permission: 'full-access', launchArgsGrantFullAccess: true })
    const asked = await keptAcpLaunchPermission(spec, noted('ask'), chat, ask, read)
    expect(asked).toMatchObject({ permission: 'ask', launchArgsGrantFullAccess: false })
  })
})
