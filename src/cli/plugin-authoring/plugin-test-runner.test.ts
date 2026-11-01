import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPluginFromTemplate } from './plugin-create'
import { checkPluginPanels, pluginStackLocation } from './plugin-panel-check'
import { findPluginTestFiles, runPluginTests } from './plugin-test-runner'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function componentsPlugin(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-plugin-test-'))
  roots.push(root)
  const dir = join(root, 'todo-panel')
  await createPluginFromTemplate({ dir, template: 'components' })
  return dir
}

describe('orca plugin test', () => {
  it(
    "runs the shipped examples' plugin tests (examples/plugins/*/src/*.test.tsx)",
    async () => {
      const dir = resolve('examples/plugins/hello-tsx')
      const files = await findPluginTestFiles(dir)
      expect(files.length).toBeGreaterThan(0)
      expect(await runPluginTests({ dir, files, quietStdout: true })).toMatchObject({ code: 0 })
    },
    // Starts its own Node process and transpiles the plugin.
    60_000
  )

  it(
    "runs the components template's own test with node:test on Orca's runtime and passes",
    async () => {
      const dir = await componentsPlugin()
      const files = await findPluginTestFiles(dir)
      expect(files).toEqual(['src/panel.test.tsx'])
      // Orca's own runtime, as on a machine with no system Node.
      const orca = {
        program: process.execPath,
        env: { ELECTRON_RUN_AS_NODE: '1' },
        source: 'orca' as const,
        version: process.version
      }
      expect(await runPluginTests({ dir, files, quietStdout: true, node: orca })).toEqual({
        runner: 'node',
        code: 0,
        node: 'orca'
      })
    },
    // Each run starts its own Node (or vitest) process and transpiles the plugin.
    60_000
  )

  it(
    'fails with a non-zero exit when a test fails, and skips generated folders',
    async () => {
      const dir = await componentsPlugin()
      await writeFile(
        join(dir, 'src', 'broken.test.ts'),
        "import { test } from 'node:test'\nimport assert from 'node:assert'\ntest('x', () => assert.equal(1, 2))\n"
      )
      await mkdir(join(dir, 'node_modules', 'dep'), { recursive: true })
      await writeFile(join(dir, 'node_modules', 'dep', 'a.test.ts'), '')
      const files = await findPluginTestFiles(dir)
      expect(files).toEqual(['src/broken.test.ts', 'src/panel.test.tsx'])
      const result = await runPluginTests({ dir, files, quietStdout: true })
      expect(result.code).not.toBe(0)
    },
    // Each run starts its own Node (or vitest) process and transpiles the plugin.
    60_000
  )

  it(
    "uses the plugin's own vitest when it has one",
    async () => {
      const dir = await componentsPlugin()
      await mkdir(join(dir, 'node_modules'), { recursive: true })
      await symlink(resolve('node_modules', 'vitest'), join(dir, 'node_modules', 'vitest'), 'dir')
      await writeFile(
        join(dir, 'src', 'panel.test.tsx'),
        [
          "import { expect, test } from 'vitest'",
          "import { mount } from 'orca/testing'",
          "import * as panel from './panel'",
          "test('adds one', async () => {",
          '  const view = await mount(panel)',
          "  await view.press({ text: 'Add one' })",
          "  expect(view.find({ role: 'status' })?.text).toBe('1')",
          '  expect(view.errors).toEqual([])',
          '})',
          ''
        ].join('\n')
      )
      const files = await findPluginTestFiles(dir)
      expect(await runPluginTests({ dir, files, quietStdout: true })).toMatchObject({
        runner: 'vitest',
        code: 0
      })
    },
    // Each run starts its own Node (or vitest) process and transpiles the plugin.
    120_000
  )
})

describe('orca plugin check', () => {
  it(
    'renders the template panel cleanly',
    async () => {
      const dir = await componentsPlugin()
      expect(await checkPluginPanels(dir)).toEqual([
        {
          panel: 'todo-panel',
          entry: 'src/panel.tsx',
          elements: expect.any(Number),
          issues: [],
          warnings: []
        }
      ])
    },
    // Each run starts its own Node (or vitest) process and transpiles the plugin.
    60_000
  )

  it(
    'reports a throw with its file:line, a refused layout, and dropped props',
    async () => {
      const dir = await componentsPlugin()
      await writeFile(
        join(dir, 'src', 'panel.tsx'),
        [
          "import { List, Stack, Text } from 'orca'",
          '',
          'export default function Panel() {',
          "  if (Math.random() < 2) throw new Error('kaboom')",
          '  return <Stack />',
          '}',
          ''
        ].join('\n')
      )
      const [thrown] = await checkPluginPanels(dir)
      expect(thrown.issues).toEqual([
        {
          kind: 'plugin',
          message: 'kaboom',
          location: expect.stringMatching(/^src\/panel\.tsx:4:\d+$/)
        }
      ])
      await writeFile(
        join(dir, 'src', 'panel.tsx'),
        "import { List, Text } from 'orca'\nexport default () => <List><Text>x</Text></List>\n"
      )
      const [refused] = await checkPluginPanels(dir)
      expect(refused.issues).toEqual([
        { kind: 'refused', message: expect.stringContaining('ListItem') }
      ])
      await writeFile(
        join(dir, 'src', 'panel.tsx'),
        'import { Text } from \'orca\'\nexport default () => <Text color="red">x</Text>\n'
      )
      const [dropped] = await checkPluginPanels(dir)
      expect(dropped).toMatchObject({
        issues: [],
        warnings: ['Text: ignored unknown prop "color"']
      })
    },
    // Each run starts its own Node (or vitest) process and transpiles the plugin.
    60_000
  )

  it('finds the first plugin frame in a stack', () => {
    const dir = '/p'
    expect(
      pluginStackLocation(
        dir,
        'Error: x\n    at f (file:///p/node_modules/a.js:1:2)\n    at Panel (file:///p/src/panel.tsx:9:11)'
      )
    ).toBe('src/panel.tsx:9:11')
  })
})
