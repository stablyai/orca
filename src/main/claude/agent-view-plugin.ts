import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { writeHooksJson, writeManagedScript } from '../agent-hooks/installer-utils'
import { writeHooksJsonAsync } from '../agent-hooks/hooks-json-write-async'
import { CLAUDE_AGENT_VIEW_PLUGIN } from '../../shared/claude-agent-view'
import { CLAUDE_AGENT_VIEW_MOD_SOURCE } from './agent-view-mod-source'

export const CLAUDE_AGENT_VIEW_PLUGIN_FILES: Record<string, string> = {
  '.claude-plugin/plugin.json': JSON.stringify({
    name: CLAUDE_AGENT_VIEW_PLUGIN,
    version: '0.2.0',
    description: 'Open Claude subagents from the Orca sidebar',
    author: { name: 'stablyai' },
    license: 'MIT'
  }),
  'hooks/hooks.json': JSON.stringify({ modules: ['./register.js'] }),
  'hooks/register.js': CLAUDE_AGENT_VIEW_MOD_SOURCE
}

export function ensureClaudeAgentViewPlugin(
  userDataPath: string,
  source = CLAUDE_AGENT_VIEW_MOD_SOURCE
): string {
  const files = { ...CLAUDE_AGENT_VIEW_PLUGIN_FILES, 'hooks/register.js': source }
  const version = createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0, 20)
  const root = join(userDataPath, 'claude-agent-view', version, CLAUDE_AGENT_VIEW_PLUGIN)
  for (const [path, content] of Object.entries(files)) {
    if (path.endsWith('.json')) {
      writeHooksJson(join(root, path), {}, { serialized: content })
    } else {
      writeManagedScript(join(root, path), content)
    }
  }
  return root
}

export async function ensureClaudeAgentViewPluginAsync(userDataPath: string): Promise<string> {
  const version = createHash('sha256')
    .update(JSON.stringify(CLAUDE_AGENT_VIEW_PLUGIN_FILES))
    .digest('hex')
    .slice(0, 20)
  const root = join(userDataPath, 'claude-agent-view', version, CLAUDE_AGENT_VIEW_PLUGIN)
  for (const [path, content] of Object.entries(CLAUDE_AGENT_VIEW_PLUGIN_FILES)) {
    await writeHooksJsonAsync(join(root, path), {}, { serialized: content })
  }
  return root
}
