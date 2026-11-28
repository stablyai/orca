import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../shared/bot-types'
import type { RpcContext } from '../core'
import { BOT_TOOLS_HOST_MCP_METHODS } from './bots-tools-host-mcp'

const [setHostMcpServers] = BOT_TOOLS_HOST_MCP_METHODS
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the method reads only id, folder and hostMcpServers.
const BOT = { id: 'scout', folder: 'scout', hostMcpServers: undefined } as unknown as Bot

function contextFor(caller: RpcContext['caller']) {
  const update = vi.fn(async (_id: string, edit: (bot: Bot) => Partial<Bot>) => ({
    ...BOT,
    ...edit(BOT)
  }))
  const runtime = { bots: { assertEnabled: () => {}, list: () => [BOT], update } }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the method reads only runtime.bots and caller.
  return { update, context: { runtime, caller } as unknown as RpcContext }
}

afterEach(() => {
  delete process.env.ORCA_MCP_SERVERS
})

describe('bots.tools.setHostMcpServers', () => {
  it('refuses any agent’s CLI, so a bot never grants itself the host’s servers', async () => {
    process.env.ORCA_MCP_SERVERS = '1'
    for (const caller of [
      { kind: 'local-cli' as const },
      { kind: 'paired-device' as const, deviceId: 'd', agent: true as const },
      undefined
    ]) {
      const { context, update } = contextFor(caller)
      await expect(
        setHostMcpServers!.handler({ botId: BOT.id, enabled: true }, context)
      ).rejects.toThrow('Change which servers a bot gets in Orca.')
      expect(update).not.toHaveBeenCalled()
    }
    const { context, update } = contextFor({ kind: 'desktop' })
    await expect(
      setHostMcpServers!.handler({ botId: BOT.id, enabled: true }, context)
    ).resolves.toEqual({ hostMcpServers: true })
    expect(update).toHaveBeenCalledOnce()
  })
})
