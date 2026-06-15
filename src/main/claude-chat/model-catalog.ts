import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

export type ModelEntry = { id: string; isDefault: boolean }

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function extractDefaultModel(settingsJson: unknown): string | undefined {
  if (
    settingsJson !== null &&
    typeof settingsJson === 'object' &&
    'model' in settingsJson &&
    typeof (settingsJson as Record<string, unknown>).model === 'string'
  ) {
    return (settingsJson as Record<string, unknown>).model as string
  }
  return undefined
}

function extractLastModelUsageKeys(claudeJson: unknown): string[] {
  if (claudeJson === null || typeof claudeJson !== 'object') {
    return []
  }
  const record = claudeJson as Record<string, unknown>
  if (!('projects' in record) || typeof record.projects !== 'object' || record.projects === null) {
    return []
  }
  const projects = record.projects as Record<string, unknown>
  const ids: string[] = []
  for (const projectEntry of Object.values(projects)) {
    if (
      projectEntry !== null &&
      typeof projectEntry === 'object' &&
      'lastModelUsage' in projectEntry
    ) {
      const usage = (projectEntry as Record<string, unknown>).lastModelUsage
      if (usage !== null && typeof usage === 'object') {
        ids.push(...Object.keys(usage as Record<string, unknown>))
      }
    }
  }
  return ids
}

export function collectModels(settingsJson: unknown, claudeJson: unknown): ModelEntry[] {
  const defaultId = extractDefaultModel(settingsJson)
  const usageIds = extractLastModelUsageKeys(claudeJson)

  // Deduplicate: default first, then the rest sorted descending alphabetically.
  const seen = new Set<string>()
  const result: ModelEntry[] = []

  if (defaultId !== undefined) {
    seen.add(defaultId)
    result.push({ id: defaultId, isDefault: true })
  }

  const others = [...new Set(usageIds)]
    .filter((id) => !seen.has(id))
    .sort((a, b) => b.localeCompare(a))

  for (const id of others) {
    result.push({ id, isDefault: false })
  }

  return result
}

async function readJsonFile(filePath: string): Promise<unknown> {
  try {
    const text = await readFile(filePath, 'utf-8')
    return safeParseJson(text)
  } catch {
    return undefined
  }
}

export async function listModels(home?: string): Promise<ModelEntry[]> {
  const homeDir = home ?? homedir()
  const [settingsJson, claudeJson] = await Promise.all([
    readJsonFile(join(homeDir, '.claude', 'settings.json')),
    readJsonFile(join(homeDir, '.claude.json'))
  ])
  return collectModels(settingsJson, claudeJson)
}
