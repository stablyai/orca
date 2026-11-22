// Removing a bot's tools from the host: the tools file entry goes, and the agent CLI's own
// sign-in for it is signed out unless another bot on the same account still uses it.
import { access, rm } from 'node:fs/promises'
import type { BotToolServer } from '../../shared/bot-tools'
import { claudeUnmirrorArgs } from './bot-tools-claude'
import { changeBotToolServers, readBotToolServers } from './bot-tools-file'
import {
  hasBotToolsCli,
  runBotToolsCli,
  type BotToolsCli,
  type BotToolsHome
} from './bot-tools-host'

/** Both CLIs keep one sign-in per account by name and URL, so another bot's same tool uses it too. */
async function signInShared(cli: BotToolsCli, server: BotToolServer | undefined): Promise<boolean> {
  if (!server || !('url' in server)) {
    return false
  }
  const others = await Promise.all(cli.otherBotFolders.map((folder) => readBotToolServers(folder)))
  return others.some((servers) =>
    servers.some(
      (other) => other.name === server.name && 'url' in other && other.url === server.url
    )
  )
}

async function signOut(home: BotToolsHome, name: string, server: BotToolServer | undefined) {
  // Relayed (saved values or Orca's own sign-in): the CLI never signed in; removal revokes Orca's.
  // Another agent has no CLI Orca signed it in through.
  if ((server && 'url' in server && server.credential) || !hasBotToolsCli(home)) {
    return
  }
  const cli = home
  const keepSignIn = await signInShared(cli, server)
  if (cli.agent === 'claude') {
    if (
      await access(cli.signInFolder).then(
        () => true,
        () => false
      )
    ) {
      // Signing out while Claude still knows the server drops its stored token.
      if (!keepSignIn) {
        await runBotToolsCli(cli, ['mcp', 'logout', name], cli.signInFolder).catch(() => null)
      }
      await runBotToolsCli(cli, claudeUnmirrorArgs(name), cli.signInFolder).catch(() => null)
    }
  } else if (server && 'url' in server && !keepSignIn) {
    // Codex keeps a sign-in by name and URL, so a later tool of the same name would reuse it.
    const config = `mcp_servers.${name}.url=${JSON.stringify(server.url)}`
    await runBotToolsCli(cli, ['mcp', 'logout', name, '-c', config]).catch(() => null)
  }
}

export async function removeBotTool(cli: BotToolsHome, name: string): Promise<void> {
  const servers = await readBotToolServers(cli.folder)
  await signOut(
    cli,
    name,
    servers.find((server) => server.name === name)
  )
  await changeBotToolServers(cli.folder, (current) =>
    current.filter((server) => server.name !== name)
  )
}

/** A deleted bot's sign-ins and Claude sign-in folder; its tool file goes with its home folder. */
export async function forgetBotTools(cli: BotToolsHome): Promise<void> {
  for (const server of await readBotToolServers(cli.folder)) {
    await signOut(cli, server.name, server)
  }
  await rm(cli.signInFolder, { recursive: true, force: true })
}
