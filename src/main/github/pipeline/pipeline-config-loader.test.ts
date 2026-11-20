import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_PIPELINE_CONFIG } from '../../../shared/github/issue-flow/pipeline-config'
import {
  clearPipelineConfigCache,
  loadPipelineConfig,
  PIPELINE_CONFIG_RELATIVE_PATH
} from './pipeline-config-loader'

const ROOT = join('C:', 'work', 'demo')
const EXPECTED_PATH = join(ROOT, PIPELINE_CONFIG_RELATIVE_PATH)

describe('pipeline-config-loader', () => {
  it('loads a valid file config', async () => {
    clearPipelineConfigCache()
    const seen: string[] = []
    const result = await loadPipelineConfig(ROOT, async (path) => {
      seen.push(path)
      return JSON.stringify(DEFAULT_PIPELINE_CONFIG)
    })
    expect(seen).toEqual([EXPECTED_PATH])
    expect(result).toEqual({ config: DEFAULT_PIPELINE_CONFIG, source: 'file' })
  })

  it('falls back to default when the file is missing', async () => {
    clearPipelineConfigCache()
    const result = await loadPipelineConfig(ROOT, async () => {
      throw new Error('ENOENT')
    })
    expect(result.source).toBe('default')
    expect(result.config).toBe(DEFAULT_PIPELINE_CONFIG)
    expect(result.error).toContain('not found')
  })

  it('falls back to default on invalid JSON and invalid config', async () => {
    clearPipelineConfigCache()
    const badJson = await loadPipelineConfig(ROOT, async () => '{oops')
    expect(badJson.source).toBe('default')
    expect(badJson.error).toContain('not valid JSON')
    clearPipelineConfigCache()
    const badConfig = await loadPipelineConfig(ROOT, async () =>
      JSON.stringify({ version: 1, initial: 'a', stages: [] })
    )
    expect(badConfig.source).toBe('default')
    expect(badConfig.error).toContain('at least one stage')
  })

  it('caches per workspace root', async () => {
    clearPipelineConfigCache()
    let calls = 0
    const reader = async () => {
      calls += 1
      return JSON.stringify(DEFAULT_PIPELINE_CONFIG)
    }
    await loadPipelineConfig(ROOT, reader)
    await loadPipelineConfig(ROOT, reader)
    expect(calls).toBe(1)
  })
})
