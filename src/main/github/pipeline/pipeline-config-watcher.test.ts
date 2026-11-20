import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_PIPELINE_CONFIG } from '../../../shared/github/issue-flow/pipeline-config'
import {
  clearPipelineConfigCache,
  invalidatePipelineConfig,
  loadPipelineConfig
} from './pipeline-config-loader'
import { pipelineConfigRootForPath } from './pipeline-config-watcher'

describe('pipeline-config-watcher', () => {
  it('extracts the workspace root from pipeline config paths', () => {
    expect(pipelineConfigRootForPath(join('C:', 'work', 'demo', '.orca', 'pipeline.json'))).toBe(
      join('C:', 'work', 'demo')
    )
    expect(pipelineConfigRootForPath('/home/demo/.orca/pipeline.json')).toBe('/home/demo')
  })

  it('ignores unrelated paths', () => {
    expect(pipelineConfigRootForPath('/home/demo/.orca/other.json')).toBe(null)
    expect(pipelineConfigRootForPath('/home/demo/pipeline.json')).toBe(null)
    expect(pipelineConfigRootForPath('/home/demo/.orca/nested/pipeline.json')).toBe(null)
  })

  it('invalidates a cached root so the next load re-reads', async () => {
    const root = join('C:', 'work', 'cached')
    clearPipelineConfigCache()
    let calls = 0
    const reader = async () => {
      calls += 1
      return JSON.stringify(DEFAULT_PIPELINE_CONFIG)
    }
    await loadPipelineConfig(root, reader)
    expect(invalidatePipelineConfig(root)).toBe(true)
    expect(invalidatePipelineConfig(root)).toBe(false)
    await loadPipelineConfig(root, reader)
    expect(calls).toBe(2)
  })
})
