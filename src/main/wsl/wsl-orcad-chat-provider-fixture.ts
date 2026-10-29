import { vi } from 'vitest'
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

/** Each guest CLI the lane installs: the provider fixture script it runs, from this repo. */
const GUEST_CLI_FIXTURES = {
  claude: 'src/main/claude/__fixtures__/claude-agent-sdk-scripted-cli.mjs',
  codex: 'src/main/codex/__fixtures__/codex-app-server-scripted-cli.mjs',
  grok: 'src/main/acp/__fixtures__/grok-acp-scripted-cli.mjs',
  opencode: 'src/main/acp/__fixtures__/opencode-acp-scripted-cli.mjs'
} as const

export type WslChatGuestAgent = keyof typeof GUEST_CLI_FIXTURES

export type WslGuestCli = { script: string; cli: string }

/** Where a scripted provider reports its launch and waits for the test to see its partial reply. */
export type WslScriptedProviderInstall = WslGuestCli & {
  agent: 'codex' | 'grok' | 'opencode'
  accountHome: string
  reportPath: string
  ackPath: string
}

/** Install each wire fixture as its agent's command on the guest's login PATH, run by the guest's packaged runtime. */
export async function installWslChatFixture(lane: WslChatHost) {
  const home = (await lane.guest('printf %s "$HOME"')).trim()
  const root = `${home}/wsl chat fixture`
  const dirs = [
    `${root}/codex-home`,
    `${root}/grok-home`,
    `${root}/opencode-home`,
    `${home}/${WSL_CHAT_GUEST_BIN}`
  ]
  await lane.guest(`mkdir -p ${dirs.map(quotePosixShell).join(' ')}`)
  const runtime = (await lane.guest(`readlink -f /proc/${lane.runtimePid}/exe`)).trim()
  const installCli = async (agent: WslChatGuestAgent): Promise<WslGuestCli> => {
    const script = `${root}/${agent}-scripted.mjs`
    const cli = `${home}/${WSL_CHAT_GUEST_BIN}/${agent}`
    await writeChatFixtureFile(
      lane,
      script,
      readFileSync(resolve(GUEST_CLI_FIXTURES[agent]), 'utf8')
    )
    await writeChatFixtureFile(
      lane,
      cli,
      `#!/bin/sh\nexport ORCA_LANE_CLI_WRAPPER="$0"\nexec ${quotePosixShell(runtime)} ${quotePosixShell(script)} "$@"\n`
    )
    await lane.guest(`chmod 700 ${quotePosixShell(cli)}`)
    return { script, cli }
  }
  const claude = await installCli('claude')
  const scripted = async (
    agent: WslScriptedProviderInstall['agent']
  ): Promise<WslScriptedProviderInstall> => ({
    ...(await installCli(agent)),
    agent,
    accountHome: `${root}/${agent}-home`,
    reportPath: `${root}/${agent}-report.json`,
    ackPath: `${root}/${agent}-partial-observed`
  })
  const codex = await scripted('codex')
  const grok = await scripted('grok')
  const opencode = await scripted('opencode')
  // No Command setting: orcad must find each CLI the way a user's install is found.
  await lane.rpc('settings.update', {
    nativeChatPermissionMode: 'ask',
    agentDefaultEnv: {
      claude: {
        ORCA_SDK_CONTRACT_SCENARIO_PATH: `${root}/scenario.json`,
        ORCA_SDK_CONTRACT_REPORT_PATH: `${root}/report.json`,
        ORCA_SDK_CONTRACT_TIMEOUT_MS: '120000'
      },
      codex: {
        CODEX_HOME: codex.accountHome,
        ORCA_CODEX_CONTRACT_REPORT_PATH: codex.reportPath,
        ORCA_CODEX_CONTRACT_ACK_PATH: codex.ackPath
      },
      grok: {
        GROK_HOME: grok.accountHome,
        ORCA_ACP_CONTRACT_REPORT_PATH: grok.reportPath,
        ORCA_ACP_CONTRACT_ACK_PATH: grok.ackPath
      },
      // An unmanaged OpenCode account keeps the user's own data dir, set here like a user's env.
      opencode: {
        XDG_DATA_HOME: opencode.accountHome,
        ORCA_ACP_CONTRACT_REPORT_PATH: opencode.reportPath,
        ORCA_ACP_CONTRACT_ACK_PATH: opencode.ackPath
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
    ...claude,
    codex,
    grok,
    opencode,
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

const PROVIDER_REPORT_TIMEOUT_MS = 30_000

/** Scripted providers rewrite their report in place after each act, so one read can see a torn file or a stale one. */
export async function waitForProviderReport<T>(
  host: WslChatHost,
  path: string,
  schema: z.ZodType<T>,
  settled: (report: T) => boolean,
  awaiting: string
): Promise<T> {
  let lastRead = ''
  try {
    return await vi.waitFor(
      async () => {
        lastRead = await host.guest(`cat ${quotePosixShell(path)} 2>/dev/null || true`)
        const report = schema.parse(JSON.parse(lastRead))
        if (!settled(report)) {
          throw new Error(`report does not show ${awaiting} yet`)
        }
        return report
      },
      { timeout: PROVIDER_REPORT_TIMEOUT_MS, interval: 250 }
    )
  } catch (error) {
    throw new Error(
      `Provider report ${path} did not show ${awaiting} within ${PROVIDER_REPORT_TIMEOUT_MS} ms; last read ${JSON.stringify(lastRead.slice(-600))}`,
      { cause: error }
    )
  }
}
