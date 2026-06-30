import { mkdir, readFile, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { dirname, join, resolve } from 'path'

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readJson(path: string): Promise<JsonRecord> {
  if (!existsSync(path)) {
    return {}
  }
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export async function writeArchitectureMcpConfig(projectPath: string): Promise<{
  claudePath: string
  codexPath: string
}> {
  const resolvedProjectPath = resolve(projectPath)
  const claudePath = join(resolvedProjectPath, '.mcp.json')
  const codexPath = join(resolvedProjectPath, '.codex', 'config.toml')

  const claudeConfig = await readJson(claudePath)
  const mcpServers = isRecord(claudeConfig.mcpServers) ? claudeConfig.mcpServers : {}
  mcpServers.scryer = {
    command: 'orca',
    args: ['scryer-mcp', '--project', resolvedProjectPath],
    env: { SCRYER_PROJECT_PATH: resolvedProjectPath }
  }
  await mkdir(dirname(claudePath), { recursive: true })
  await writeFile(claudePath, JSON.stringify({ ...claudeConfig, mcpServers }, null, 2), 'utf8')

  await mkdir(dirname(codexPath), { recursive: true })
  await writeFile(
    codexPath,
    [
      '[mcp_servers.scryer]',
      'command = "orca"',
      `args = ["scryer-mcp", "--project", ${JSON.stringify(resolvedProjectPath)}]`,
      '',
      '[mcp_servers.scryer.env]',
      `SCRYER_PROJECT_PATH = ${JSON.stringify(resolvedProjectPath)}`,
      ''
    ].join('\n'),
    'utf8'
  )

  return { claudePath, codexPath }
}
