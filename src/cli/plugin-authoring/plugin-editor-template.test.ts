import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPluginFromTemplate } from './plugin-create'
import { checkPluginEditors } from './plugin-editor-check'
import { findPluginTestFiles, runPluginTests } from './plugin-test-runner'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function editorPlugin(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-editor-template-'))
  roots.push(root)
  const dir = join(root, 'sketch')
  await createPluginFromTemplate({ dir, template: 'editor' })
  return dir
}

describe('orca plugin create --template editor', () => {
  it(
    'passes plugin check and plugin test as generated',
    async () => {
      const dir = await editorPlugin()
      const [check] = await checkPluginEditors(dir)
      expect(check?.issues).toEqual([])
      expect(check?.files).toEqual(['editor/main.ts', 'editor/sync.ts'])
      const files = await findPluginTestFiles(dir)
      expect(files).toEqual(['editor/sync.test.ts'])
      expect(await runPluginTests({ dir, files, quietStdout: true })).toMatchObject({ code: 0 })
    },
    // The test run starts its own Node process and transpiles the plugin.
    60_000
  )
})
