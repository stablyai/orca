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

/** Guest dir the lane's login profile puts first on PATH, before WSL's appended Windows entries. */
export const WSL_CHAT_GUEST_BIN = 'orca-lane-chat-bin'

/** Install the SDK wire fixture as `claude` on the guest's login PATH, run by the guest's packaged runtime. */
export async function installWslChatFixture(lane: WslChatHost) {
  const home = (await lane.guest('printf %s "$HOME"')).trim()
  const root = `${home}/wsl chat fixture`
  await lane.guest(
    `mkdir -p ${quotePosixShell(root)} ${quotePosixShell(`${home}/${WSL_CHAT_GUEST_BIN}`)}`
  )
  const runtime = (await lane.guest(`readlink -f /proc/${lane.runtimePid}/exe`)).trim()
  const script = `${root}/scripted.mjs`
  const cli = `${home}/${WSL_CHAT_GUEST_BIN}/claude`
  await writeChatFixtureFile(
    lane,
    script,
    readFileSync(resolve('src/main/claude/__fixtures__/claude-agent-sdk-scripted-cli.mjs'), 'utf8')
  )
  await writeChatFixtureFile(
    lane,
    cli,
    `#!/bin/sh\nexport ORCA_LANE_CLAUDE_WRAPPER="$0"\nexec ${quotePosixShell(runtime)} ${quotePosixShell(script)} "$@"\n`
  )
  await lane.guest(`chmod 700 ${quotePosixShell(cli)}`)
  // No Command setting: orcad must find `claude` the way a user's install is found.
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
  return {
    home,
    root,
    script,
    cli,
    folderPath,
    folderWorktree: folderWorkspaceKey(folder.folderWorkspace.id)
  }
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
