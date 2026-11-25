// Pi's terminal: an extension Orca loads with it registers the host list's servers for that run.
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { piMcpServersConfig, piMcpServersExtensionSource } from '../../bots/bot-tools-pi'
import {
  getDefaultPiAgentDir,
  ORCA_MANAGED_EXTENSION_MARKER,
  withOrcaManagedExtensionMarker
} from '../../pi/managed-extensions/titlebar-extension-service'
import { writePluginFileAtomically } from '../../plugins/installation/plugin-atomic-file-write'
import {
  cliRefusal,
  launchTextFilePath,
  NOT_PLAIN,
  platformOf,
  shimmed,
  skip,
  withArgs,
  type TerminalMcpAdapter,
  type TerminalMcpDelivery
} from './terminal-mcp-delivery'

export const PI_TERMINAL_MCP_SERVERS_ENV = 'ORCA_PI_MCP_SERVERS'
const PI_TERMINAL_MCP_EXTENSION_FILE = 'orca-mcp-servers.ts'

/** Writes Orca's marked extension into the Pi agent dir; a user's own file of that name stays. */
async function installPiMcpExtension(agentDir: string): Promise<boolean> {
  const dir = join(agentDir, 'extensions')
  const path = join(dir, PI_TERMINAL_MCP_EXTENSION_FILE)
  const source = withOrcaManagedExtensionMarker(
    piMcpServersExtensionSource(PI_TERMINAL_MCP_SERVERS_ENV)
  )
  try {
    const installed = await readFile(path, 'utf8').catch(() => undefined)
    if (installed === source) {
      return true
    }
    if (installed !== undefined && !installed.includes(ORCA_MANAGED_EXTENSION_MARKER)) {
      return false
    }
    await mkdir(dir, { recursive: true })
    await writePluginFileAtomically(path, source)
    return true
  } catch {
    return false
  }
}

/** Pi loads Orca's marked extension from its agent dir; it adds the servers only for a run that
 *  sets its variable. A WSL guest's agent dir is the guest's own, so there Pi is handed the
 *  extension by path (`--extension`), at a launch file it reads through its drive mount. */
// `pi.registerMcpServer`, which the extension needs (as Pi bot tools do).
const PI_REGISTERS_MCP_SERVERS_VERSION = '0.99.0'

export const pi: TerminalMcpAdapter = {
  agent: 'pi',
  executables: ['pi'],
  wsl: true,
  async deliver(launch, executable) {
    const platform = platformOf(launch)
    const delivered = (command?: string): TerminalMcpDelivery => ({
      delivered: true,
      ...(command ? { command } : {}),
      env: {
        [PI_TERMINAL_MCP_SERVERS_ENV]: piMcpServersConfig(
          launch.servers.map((server) => shimmed(server, platform))
        )
      },
      tokenInEnv: true
    })
    // An older Pi loads the extension but has no registerMcpServer, so it would take none of them.
    // Unchecked in time, it still goes: the extension does nothing on a Pi without it.
    const refused = await cliRefusal(
      launch,
      executable,
      { version: PI_REGISTERS_MCP_SERVERS_VERSION },
      `Update Pi${launch.wsl ? ' in WSL' : ''} to ${PI_REGISTERS_MCP_SERVERS_VERSION} or later to use Orca’s servers in its terminal`
    )
    if (refused && !refused.delivered && refused.agentWide) {
      return refused
    }
    if (launch.wsl) {
      const path = await launchTextFilePath(
        launch,
        'pi',
        'ts',
        piMcpServersExtensionSource(PI_TERMINAL_MCP_SERVERS_ENV)
      )
      const command = path && withArgs(launch, this.executables, ['--extension', path])
      return command ? delivered(command) : skip(NOT_PLAIN)
    }
    const agentDir =
      launch.env.ORCA_PI_SOURCE_AGENT_DIR ??
      launch.env.PI_CODING_AGENT_DIR ??
      process.env.PI_CODING_AGENT_DIR ??
      getDefaultPiAgentDir('pi', undefined)
    const installed = await installPiMcpExtension(agentDir)
    if (!installed) {
      return skip('its extension couldn’t be written to the Pi agent folder')
    }
    return delivered()
  }
}
