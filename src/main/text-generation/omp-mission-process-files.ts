import { mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export type OmpMissionProcessFiles = {
  configPath: string
  extensionPath: string
}

export const OMP_MISSION_SYSTEM_PROMPT =
  'You are Orca Mission Planner. Produce only the requested JSON plan. Do not execute the mission or call tools.'

const OMP_MISSION_CONFIG = `disabledProviders:
  - agents-md
  - agents
  - native
  - claude-plugins
  - claude
  - codex
  - cursor
  - gemini
  - mcp-json
  - omp-plugins
  - opencode
  - vscode
  - windsurf
  - agent-plugins
  - github
mcp:
  enableProjectConfig: false
speechgen:
  enabled: false
`

const OMP_MISSION_PLANNER_GUARD = `export default function(api) {
  if (!api || typeof api.on !== 'function' || typeof api.setActiveTools !== 'function' || typeof api.getActiveTools !== 'function') {
    throw new Error('Orca Mission Planner guard requires the OMP extension API.')
  }

  const failClosed = () => {
    try { process.stderr.write('OMP mission planning guard failed closed.\\n') } catch {}
    process.exit(1)
  }

  const enforceNoTools = async () => {
    try {
      await api.setActiveTools([])
      const activeTools = await api.getActiveTools()
      if (!Array.isArray(activeTools) || activeTools.length !== 0) throw new Error('active tools remain')
    } catch {
      failClosed()
    }
  }

  api.on('session_start', enforceNoTools)
  api.on('before_agent_start', enforceNoTools)
  api.on('tool_call', () => ({ block: true, reason: 'Orca Mission planning does not permit tool execution.' }))
}
`

export async function withOmpMissionProcessFiles<T>(
  generate: (files: OmpMissionProcessFiles) => Promise<T>
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'orca-omp-mission-'))
  const files = {
    configPath: join(directory, 'config.yml'),
    extensionPath: join(directory, 'planner-guard.mjs')
  }

  try {
    await writeFile(files.configPath, OMP_MISSION_CONFIG, { encoding: 'utf8', mode: 0o600 })
    await writeFile(files.extensionPath, OMP_MISSION_PLANNER_GUARD, {
      encoding: 'utf8',
      mode: 0o600
    })
    return await generate(files)
  } finally {
    try {
      await Promise.all([
        rm(files.configPath, { force: true }),
        rm(files.extensionPath, { force: true })
      ])
    } finally {
      await rmdir(directory)
    }
  }
}
