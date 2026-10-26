import { z } from 'zod'
import { folderWorkspaceKey } from '../../shared/workspace-scope'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { quotePosixShell } from '../../shared/shell-argument-quoting'

export type WslChatHost = {
  rpc<T>(method: string, params?: unknown): Promise<T>
  guest(command: string): Promise<string>
  runtimePid: number
}

export async function writeChatFixtureFile(
  host: WslChatHost,
  path: string,
  content: string
): Promise<void> {
  await host.guest(
    `printf %s ${quotePosixShell(Buffer.from(content).toString('base64'))} | base64 -d > ${quotePosixShell(path)}`
  )
}

/** Install the existing SDK wire fixture with the guest's packaged runtime, never a Windows CLI. */
export async function installWslChatFixture(lane: WslChatHost) {
  const home = (await lane.guest('printf %s "$HOME"')).trim()
  const root = `${home}/wsl chat fixture`
  await lane.guest(`mkdir -p ${quotePosixShell(root)}`)
  const runtime = (await lane.guest(`readlink -f /proc/${lane.runtimePid}/exe`)).trim()
  const script = `${root}/scripted.mjs`
  const cli = `${root}/claude`
  await writeChatFixtureFile(
    lane,
    script,
    readFileSync(resolve('src/main/claude/__fixtures__/claude-agent-sdk-scripted-cli.mjs'), 'utf8')
  )
  await writeChatFixtureFile(
    lane,
    cli,
    `#!/bin/sh\nexec ${quotePosixShell(runtime)} ${quotePosixShell(script)} "$@"\n`
  )
  await lane.guest(`chmod 700 ${quotePosixShell(cli)}`)
  await lane.rpc('settings.mutateAgentLaunch', {
    type: 'command',
    agent: 'claude',
    value: quotePosixShell(cli)
  })
  await lane.rpc('settings.update', {
    nativeChatPermissionMode: 'ask',
    agentDefaultEnv: {
      claude: {
        ORCA_SDK_CONTRACT_SCENARIO_PATH: `${root}/scenario.json`,
        ORCA_SDK_CONTRACT_REPORT_PATH: `${root}/report.json`,
        ORCA_SDK_CONTRACT_TIMEOUT_MS: '120000'
      }
    }
  })
  const group = await lane.rpc<{ group: { id: string } }>('projectGroup.create', {
    name: 'WSL chat lane'
  })
  const folderPath = `${root}/folder project`
  await lane.guest(`mkdir -p ${quotePosixShell(folderPath)}`)
  const folder = await lane.rpc<{ folderWorkspace: { id: string } }>('folderWorkspace.create', {
    projectGroupId: group.group.id,
    folderPath,
    name: 'WSL folder chat'
  })
  return { home, root, folderPath, folderWorktree: folderWorkspaceKey(folder.folderWorkspace.id) }
}

export const WslChatProviderReport = z.object({
  execPath: z.string(),
  cwd: z.string(),
  argv: z.array(z.string()),
  env: z.record(z.string(), z.string()),
  userMessages: z.array(z.object({ message: z.object({ content: z.unknown() }) })),
  controlRequests: z.array(z.object({ request: z.object({ subtype: z.string() }) })),
  controlResponses: z.array(z.object({ response: z.object({ response: z.unknown().optional() }) }))
})
