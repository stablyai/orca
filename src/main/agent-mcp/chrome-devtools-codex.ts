import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '../../shared/child-process/run-process'
import { resolveCliCommand } from '../../shared/node-cli-command-resolution'
import {
  CHROME_DEVTOOLS_NAME,
  chromeDevtoolsCommand,
  configConflict,
  isRecord,
  matchesCommand,
  readConfig,
  type ConfigPlan
} from './chrome-devtools-config'

export async function planCodexConfig(
  home: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): Promise<ConfigPlan> {
  const configPath = join(home, '.codex', 'config.toml')
  const before = readConfig(configPath)
  const stagingHome = mkdtempSync(join(tmpdir(), 'orca-chrome-devtools-'))
  const stagedPath = join(stagingHome, 'config.toml')
  const program = resolveCliCommand('codex', {
    pathEnv: env.PATH ?? env.Path,
    platform,
    homePath: home
  })
  const command = chromeDevtoolsCommand(platform)
  async function listServers(): Promise<unknown[]> {
    const result = await runProcess({
      program,
      args: ['mcp', 'list', '--json'],
      cwd: stagingHome,
      env: { ...env, CODEX_HOME: stagingHome, ORCA_CODEX_HOME: stagingHome },
      timeoutMs: 15000,
      maxOutputBytes: 1024 * 1024
    })
    if (result.code !== 0 || result.timedOut || result.outputTruncated) {
      throw new Error(
        `Codex could not validate ${configPath} (exit ${result.code}, timeout ${result.timedOut}). Check the installed Codex CLI and config syntax.`
      )
    }
    const parsed: unknown = JSON.parse(result.stdout)
    if (!Array.isArray(parsed)) {
      throw new Error('Unexpected Codex mcp list response.')
    }
    return parsed
  }
  function matchesServer(server: unknown): boolean {
    if (!isRecord(server) || server.enabled === false || !isRecord(server.transport)) {
      return false
    }
    return (
      server.transport.type === 'stdio' &&
      server.transport.command === command[0] &&
      matchesCommand(server.transport.args, command.slice(1)) &&
      (!isRecord(server.transport.env) || Object.keys(server.transport.env).length === 0) &&
      server.transport.cwd == null &&
      server.enabled_tools == null &&
      server.disabled_tools == null
    )
  }
  try {
    writeFileSync(stagedPath, before ?? '', { mode: 0o600 })
    const existing = (await listServers()).find(
      (server) => isRecord(server) && server.name === CHROME_DEVTOOLS_NAME
    )
    if (existing !== undefined) {
      if (!matchesServer(existing)) {
        throw configConflict(configPath)
      }
      return { agent: 'codex', configPath, before, after: before ?? '' }
    }
    const newline = before?.includes('\r\n') ? '\r\n' : '\n'
    const after =
      (before ?? '') +
      newline +
      [
        '[mcp_servers.chrome-devtools]',
        `command = ${JSON.stringify(command[0])}`,
        `args = ${JSON.stringify(command.slice(1))}`,
        'startup_timeout_sec = 60',
        ''
      ].join(newline)
    writeFileSync(stagedPath, after, { mode: 0o600 })
    const added = (await listServers()).find(
      (server) => isRecord(server) && server.name === CHROME_DEVTOOLS_NAME
    )
    if (!matchesServer(added)) {
      throw new Error(`Codex did not validate chrome-devtools in ${configPath}.`)
    }
    return { agent: 'codex', configPath, before, after }
  } finally {
    rmSync(stagingHome, { recursive: true, force: true })
  }
}
