import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  DEFAULT_PIPELINE_CONFIG,
  validatePipelineConfig,
  type PipelineConfig
} from '../../../shared/github/issue-flow/pipeline-config'

export const PIPELINE_CONFIG_RELATIVE_PATH = join('.orca', 'pipeline.json')

export type PipelineConfigSource = 'file' | 'default'

export type PipelineConfigLoadResult = {
  config: PipelineConfig
  source: PipelineConfigSource
  error?: string
}

export type PipelineConfigFileReader = (path: string) => Promise<string>

const cache = new Map<string, PipelineConfigLoadResult>()

export function clearPipelineConfigCache(): void {
  cache.clear()
}

function fallback(reason: string): PipelineConfigLoadResult {
  return { config: DEFAULT_PIPELINE_CONFIG, source: 'default', error: reason }
}

async function readPipelineConfig(
  workspaceRoot: string,
  readFileText: PipelineConfigFileReader
): Promise<PipelineConfigLoadResult> {
  const path = join(workspaceRoot, PIPELINE_CONFIG_RELATIVE_PATH)
  let text: string
  try {
    text = await readFileText(path)
  } catch {
    return fallback(`${path} not found, using the built-in default pipeline`)
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    return fallback(`${path} is not valid JSON: ${String(error)}`)
  }
  const errors = validatePipelineConfig(value)
  if (errors.length > 0) {
    return fallback(`${path} is invalid: ${errors.join('; ')}`)
  }
  return { config: value as PipelineConfig, source: 'file' }
}

export async function loadPipelineConfig(
  workspaceRoot: string,
  readFileText: PipelineConfigFileReader = (path) => readFile(path, 'utf8')
): Promise<PipelineConfigLoadResult> {
  const cached = cache.get(workspaceRoot)
  if (cached) {
    return cached
  }
  const result = await readPipelineConfig(workspaceRoot, readFileText)
  cache.set(workspaceRoot, result)
  return result
}
