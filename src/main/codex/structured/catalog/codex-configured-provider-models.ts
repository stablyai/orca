import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { parse } from 'smol-toml'
import type { AgentSessionModelOption } from '../../../../shared/agent-session/options/model-catalog/agent-session-model-option'
import { codexProviderModelId } from '../../../../shared/agent-session/options/model-catalog/codex-provider-model'
import { labelFromModelId } from '../../../../shared/agent-session/options/model-catalog/model-id-label'

const PROFILE_FILE = /^[A-Za-z0-9_-]+\.config\.toml$/
const MAX_PROFILE_BYTES = 1024 * 1024

export async function codexModelProfileFiles(home: string): Promise<string[]> {
  const entries = await readdir(home, { withFileTypes: true }).catch(() => [])
  return entries
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && PROFILE_FILE.test(entry.name))
    .map((entry) => join(home, entry.name))
    .sort()
}

export async function readCodexProviderModels(
  files: readonly string[],
  providers: ReadonlyMap<string, string>
): Promise<AgentSessionModelOption[]> {
  if (providers.size === 0) {
    return []
  }
  const rows = new Map<string, AgentSessionModelOption>()
  for (const file of files) {
    try {
      const info = await stat(file)
      if (!info.isFile() || info.size > MAX_PROFILE_BYTES) {
        continue
      }
      const {
        model,
        model_provider: provider,
        model_reasoning_effort: effort
      } = parse(await readFile(file, 'utf8'))
      if (typeof provider !== 'string' || typeof model !== 'string' || !model.trim()) {
        continue
      }
      const label = providers.get(provider)
      if (!label) {
        continue
      }
      const id = codexProviderModelId(provider, model)
      const row: AgentSessionModelOption = rows.get(id) ?? {
        id,
        label: `${model} · ${label}`,
        isDefault: false,
        efforts: [],
        declaredDefaultEffort: null,
        effortsKnown: false
      }
      if (
        typeof effort === 'string' &&
        effort.trim() &&
        !row.efforts.some(({ value }) => value === effort)
      ) {
        row.efforts.push({
          value: effort,
          label: effort === 'xhigh' ? 'Extra high' : labelFromModelId(effort)
        })
      }
      rows.set(id, row)
    } catch {
      // Profiles can be edited or removed while the catalog is listing.
    }
  }
  return [...rows.values()]
}
