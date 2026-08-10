import { describe, expect, it } from 'vitest'
import type { GlobalSettings } from '../../shared/types'
import { RuntimeGitCommands } from './orca-runtime-git'

describe('RuntimeGitCommands remote deadline', () => {
  it('expires while runtime target resolution is hung', async () => {
    const commands = new RuntimeGitCommands({
      resolveRuntimeGitTarget: () => new Promise(() => {}),
      getRuntimeSettings: () => ({}) as GlobalSettings
    })

    await expect(commands.fetchRuntimeGit('id:wt-1', undefined, 25)).rejects.toThrow(
      'Fetch timed out.'
    )
  })
})
