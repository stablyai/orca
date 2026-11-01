import { existsSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPluginFromTemplate } from './plugin-create'
import { parsePluginDeclarativeTree } from '../../shared/plugins/declarative/plugin-declarative-tree'
import {
  checkPluginPanels,
  formatPluginPanelCheck,
  readPluginCheckScenarioNames,
  pluginPanelCheckIssues,
  pluginStackLocation
} from './plugin-panel-check'
import { findPluginTestFiles, PLUGIN_TEST_FILE, runPluginTests } from './plugin-test-runner'

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

const EXAMPLES = resolve(__dirname, '../../../examples/plugins')
// Every example with its own tests (examples/plugins/*/src/*.test.tsx).
const TESTED_EXAMPLES = readdirSync(EXAMPLES).filter((name) => {
  const src = join(EXAMPLES, name, 'src')
  return existsSync(src) && readdirSync(src).some((file) => PLUGIN_TEST_FILE.test(file))
})

describe('orca plugin test with a worker', () => {
  it(
    "runs a .ts worker's own tests through mountWorker, resolving its imports as Orca does",
    async () => {
      const dir = await componentsPlugin()
      const manifestPath = join(dir, 'orca-plugin.json')
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      await writeFile(
        manifestPath,
        JSON.stringify({
          ...manifest,
          execution: 'trusted-worker',
          main: 'src/worker.ts',
          capabilities: [{ kind: 'agent:read' }, { kind: 'notifications:show' }],
          contributes: { ...manifest.contributes, events: [{ on: 'agent.status.changed' }] }
        })
      )
      await writeFile(
        join(dir, 'src', 'labels.ts'),
        "import { basename } from 'node:path'\nexport const label = (key: string): string => basename(key)\n"
      )
      await writeFile(
        join(dir, 'src', 'worker.ts'),
        [
          "import type { OrcaWorkerApi } from 'orca/worker'",
          "import { label } from './labels'",
          'export default function activate(orca: OrcaWorkerApi): void {',
          "  orca.events.on('agent.status.changed', async (event) => {",
          "    if (event.state === 'blocked') {",
          "      await orca.host.call('notifications.show', { title: label(event.paneKey) })",
          '    }',
          '  })',
          '}',
          ''
        ].join('\n')
      )
      await writeFile(
        join(dir, 'src', 'worker.test.ts'),
        [
          "import { assert, mountWorker, test } from 'orca/testing'",
          "import * as main from './worker'",
          "test('notifies when an agent is blocked', async () => {",
          '  const worker = await mountWorker(main)',
          "  await worker.emit('agent.status.changed', { workspaceId: null, paneKey: 'a/b', state: 'blocked', receivedAt: 1 })",
          "  assert.deepEqual(worker.host.callsOf('notifications.show'), [{ title: 'b' }])",
          '  assert.deepEqual(worker.refusals, [])',
          '  await worker.deactivate()',
          '})',
          ''
        ].join('\n')
      )
      const files = (await findPluginTestFiles(dir)).filter((file) => file.includes('worker'))
      expect(await runPluginTests({ dir, files, quietStdout: true })).toMatchObject({ code: 0 })
    },
    // Starts its own Node process and transpiles the plugin.
    60_000
  )
})

describe('the example plugins', () => {
  it('include the build-less and gallery examples', () => {
    expect(TESTED_EXAMPLES).toEqual(expect.arrayContaining(['hello-tsx', 'components-gallery']))
  })

  it.each(TESTED_EXAMPLES)(
    '%s passes its own tests and renders without problems',
    async (example) => {
      const dir = join(EXAMPLES, example)
      const files = await findPluginTestFiles(dir)
      expect(files.length).toBeGreaterThan(0)
      expect(await runPluginTests({ dir, files, quietStdout: true })).toMatchObject({
        runner: 'node',
        code: 0
      })
      const checks = await checkPluginPanels(dir)
      expect(checks.map(({ issues, warnings }) => ({ issues, warnings }))).toEqual(
        checks.map(() => ({ issues: [], warnings: [] }))
      )
    },
    // Each run starts its own Node process and transpiles the plugin.
    60_000
  )
})

describe('orca plugin check', () => {
  it(
    "runs the plugin's worker so panel requests reach it, and renders each fixture scenario",
    async () => {
      const dir = await componentsPlugin()
      const manifestPath = join(dir, 'orca-plugin.json')
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      await writeFile(
        manifestPath,
        JSON.stringify({
          ...manifest,
          execution: 'trusted-worker',
          main: 'src/worker.ts',
          capabilities: [{ kind: 'agent:read' }]
        })
      )
      await writeFile(
        join(dir, 'src', 'worker.ts'),
        [
          "import type { OrcaWorkerApi } from 'orca/worker'",
          'export default function activate(orca: OrcaWorkerApi): void {',
          "  orca.panels.handle('stats', () => ({ changes: 7 }))",
          '}',
          ''
        ].join('\n')
      )
      await writeFile(
        join(dir, 'src', 'panel.tsx'),
        [
          "import { atom, host, List, ListItem, plugin, read, set, Text } from 'orca'",
          "const changes = atom<number | null>('changes', null)",
          "const names = atom<string[]>('names', [])",
          'export function setup(): void {',
          "  void plugin.request('stats').then((stats) => set(changes, (stats as { changes: number }).changes))",
          "  void host.call('agents.list').then(({ agents }) => set(names, agents.map((agent) => agent.title ?? '?')))",
          '}',
          'export default function Panel() {',
          '  return (',
          '    <List label="Agents">',
          '      {read(names).map((name) => <ListItem key={name} title={name} />)}',
          '      <ListItem key="#changes" title={`changes ${read(changes)}`} />',
          '    </List>',
          '  )',
          '}',
          ''
        ].join('\n')
      )
      await writeFile(
        join(dir, 'src', 'panel.check.ts'),
        [
          "import { defineCheck } from 'orca/testing'",
          'export default defineCheck({',
          '  empty: {},',
          '  busy: {',
          "    results: { 'agents.list': { agents: [",
          "      { terminalId: 't1', title: 'Claude', agent: 'claude', state: 'working', stateStartedAt: 1 },",
          "      { terminalId: 't2', title: 'Codex', agent: 'codex', state: 'done', stateStartedAt: 1 }",
          '    ] } }',
          '  }',
          '})',
          ''
        ].join('\n')
      )
      const checks = await checkPluginPanels(dir)
      expect(
        checks.map(({ scenario, elements, issues, warnings }) => ({
          scenario,
          elements,
          issues,
          warnings
        }))
      ).toEqual([
        { scenario: 'empty', elements: 1, issues: [], warnings: [] },
        { scenario: 'busy', elements: 3, issues: [], warnings: [] }
      ])
      // What each scenario drew, at a glance, and the full tree for --json.
      expect(checks.map((check) => check.summary)).toEqual([
        ['List "Agents": 1 item(s)'],
        ['List "Agents": 3 item(s)']
      ])
      expect(checks[1]?.tree).toMatchObject({ type: 'List', props: { label: 'Agents' } })
      // One scenario, with the tree Orca would draw: it validates and keeps live handler ids.
      expect(await readPluginCheckScenarioNames(dir, 'src/panel.tsx')).toEqual(['empty', 'busy'])
      const [busy] = await checkPluginPanels(dir, { scenario: 'busy', drawnTree: true })
      expect(busy).toMatchObject({ scenario: 'busy', issues: [] })
      expect(busy?.drawnTree).toMatchObject({ type: 'List', props: { label: 'Agents' } })
      expect(parsePluginDeclarativeTree(busy?.drawnTree).ok).toBe(true)
      const [missing] = await checkPluginPanels(dir, { scenario: 'nope' })
      expect(missing?.issues.map((issue) => issue.message)).toEqual([
        'no check scenario named "nope" in src/panel.check.ts'
      ])
      expect(formatPluginPanelCheck(checks[1]!)).toEqual([
        'todo-panel (src/panel.tsx, scenario "busy"): rendered 3 element(s)',
        '  List "Agents": 3 item(s)'
      ])

      await writeFile(join(dir, 'src', 'worker.ts'), 'export function activate(): void {}\n')
      await writeFile(join(dir, 'src', 'panel.check.ts'), 'export default {}\n')
      const [broken] = await checkPluginPanels(dir)
      expect(broken.issues.map((issue) => issue.message)).toEqual([
        expect.stringContaining('must export default'),
        expect.stringMatching(/^worker \(src\/worker\.ts\): .*exports activate by name/),
        'no panel handler named stats'
      ])
    },
    // Each run starts its own Node process and transpiles the plugin.
    60_000
  )

  it(
    'renders the template panel cleanly',
    async () => {
      const dir = await componentsPlugin()
      expect(await checkPluginPanels(dir)).toEqual([
        {
          panel: 'todo-panel',
          entry: 'src/panel.tsx',
          elements: expect.any(Number),
          summary: ['Heading "Counter"'],
          tree: expect.objectContaining({ type: 'Stack' }),
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
      await writeFile(join(dir, 'src', 'panel.tsx'), "import { Text } from 'orca'\nconst = 1\n")
      const [broken] = await checkPluginPanels(dir)
      expect(broken.issues).toEqual([
        { kind: 'plugin', message: 'Unexpected token', location: 'src/panel.tsx:2:7' }
      ])
    },
    // Each run starts its own Node (or vitest) process and transpiles the plugin.
    60_000
  )

  it('locates transpile errors from their message and lists a repeated error once', () => {
    const stack = 'Error: kaboom\n    at Panel (file:///p/src/panel.tsx:4:41)'
    expect(
      pluginPanelCheckIssues('/p', [
        { kind: 'plugin', message: 'kaboom', stack },
        { kind: 'plugin', message: 'kaboom', stack },
        { kind: 'plugin', message: 'src/lib/a.ts:3:9: Unexpected token', stack: 'SyntaxError' },
        { kind: 'refused', message: 'kaboom' }
      ])
    ).toEqual([
      { kind: 'plugin', message: 'kaboom', location: 'src/panel.tsx:4:41' },
      { kind: 'plugin', message: 'Unexpected token', location: 'src/lib/a.ts:3:9' },
      { kind: 'refused', message: 'kaboom' }
    ])
  })

  it(
    'warns about host calls Orca would refuse, and reports a repeated throw once',
    async () => {
      const dir = await componentsPlugin()
      await writeFile(
        join(dir, 'src', 'panel.tsx'),
        [
          "import { atom, host, read, set, Text } from 'orca'",
          'const tick = atom(0)',
          'export function setup() {',
          "  void host.call('workspace.readContext').catch(() => undefined)",
          '  void Promise.resolve().then(() => set(tick, 1))',
          '}',
          'export default function Panel() {',
          "  if (read(tick) >= 0) throw new Error('again')",
          '  return <Text>x</Text>',
          '}',
          ''
        ].join('\n')
      )
      const [check] = await checkPluginPanels(dir)
      expect(check.issues).toEqual([
        { kind: 'plugin', message: 'again', location: expect.stringMatching(/^src\/panel\.tsx:8:/) }
      ])
      expect(check.warnings).toEqual([
        'host refused workspace.readContext (capability_denied): workspace.readContext needs the workspace:read capability'
      ])
    },
    // Each run starts its own Node process and transpiles the plugin.
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
