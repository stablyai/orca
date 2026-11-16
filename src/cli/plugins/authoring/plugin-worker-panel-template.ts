import {
  COMMON_FILES,
  json,
  manifest,
  readme,
  type PluginTemplate,
  type PluginTemplateInput
} from './plugin-template-files'
import { PLUGIN_TYPES_DIR } from './plugin-type-files'

const PROTOCOL_TS = `// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
export {}

declare module 'orca' {
  interface PluginRequests {
    /** The total the worker keeps in storage. */
    'counter.get': { output: { total: number } }
    /** Adds \`by\` to the stored total and answers the new total. */
    'counter.add': { input: { by: number }; output: { total: number } }
  }
  interface PluginPanelEvents {
    /** Posted to every open panel after the total changes. */
    'counter.changed': { total: number }
  }
}
`

const PANEL_CHECK_TS = `// \`orca plugin check\` renders the panel once per scenario, each with the worker on a fresh
// host. Seed what the worker reads so check shows more than the first state.
import { defineCheck } from 'orca/testing'

export default defineCheck({
  fresh: {},
  counted: { storage: { total: 41 } }
})
`

const WORKER_TS = `// The plugin's own worker. Orca starts it on the panel's first plugin.request and transpiles
// this file when it loads: no build step. A save restarts it and drops its in-memory state, so
// the total lives in orca.storage (the storage:own capability).
import type { OrcaWorkerApi } from 'orca/worker'

const TOTAL = 'total'

async function storedTotal(orca: OrcaWorkerApi): Promise<number> {
  const value = await orca.storage.get(TOTAL)
  return typeof value === 'number' ? value : 0
}

export default function activate(orca: OrcaWorkerApi): void {
  orca.panels.handle('counter.get', async () => ({ total: await storedTotal(orca) }))

  orca.panels.handle('counter.add', async ({ by }) => {
    const total = (await storedTotal(orca)) + by
    await orca.storage.set(TOTAL, total)
    // Every open panel hears it, so a second panel stays in step.
    orca.panels.post('counter.changed', { total })
    return { total }
  })
}
`

const PANEL_TSX = `// No build step: Orca strips the types and compiles the JSX when the panel loads.
import {
  atom,
  Badge,
  Button,
  Heading,
  plugin,
  read,
  Row,
  set,
  Stack,
  Text,
  update,
  type PanelContext
} from 'orca'

/** What the worker last reported; null until it answers. */
const total = atom<number | null>(null)
/** A keyed atom: \`persist: 'plugin'\` keeps it across panel runs. */
const step = atom('step', 1, { persist: 'plugin' })

async function add(): Promise<void> {
  // Typed by src/protocol.ts; starts the worker if it is not running.
  const answer = await plugin.request('counter.add', { by: read(step) })
  set(total, answer.total)
}

/** Runs once before the first render; what it pushes to \`subscriptions\` ends with the panel. */
export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('counter.changed', (payload) => set(total, payload.total)))
  void plugin.request('counter.get').then((answer) => set(total, answer.total))
}

export default function Panel() {
  const value = read(total)
  const by = read(step)
  return (
    <Stack gap="md">
      <Row justify="between">
        <Heading>Counter</Heading>
        <Badge tone="accent">{value === null ? '-' : value}</Badge>
      </Row>
      <Row gap="xs">
        <Button onPress={add}>Add {by}</Button>
        <Button variant="ghost" onPress={() => update(step, (n) => (n === 1 ? 10 : 1))}>
          Step {by === 1 ? 10 : 1}
        </Button>
      </Row>
      <Text muted size="xs">
        src/worker.ts keeps the total in storage. Edit either file and save: Orca reloads it.
      </Text>
    </Stack>
  )
}
`

const PANEL_TEST_TSX = `// \`orca plugin test .\` runs this in Node with the same runtime and checks Orca uses.
import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'

test('shows the worker total and adds the step', async () => {
  let total = 4
  // Stands in for src/worker.ts: what each plugin.request answers.
  const host = mockHost({
    requests: {
      'counter.get': () => ({ total }),
      'counter.add': ({ by }) => ({ total: (total += by) })
    }
  })
  const view = await mount(panel, { host })
  assert.equal(view.find({ role: 'status' })?.text, '4')

  await view.press({ text: 'Add 1' })
  assert.equal(view.find({ role: 'status' })?.text, '5')

  await view.press({ text: 'Step 10' })
  await view.press({ text: 'Add 10' })
  assert.equal(view.find({ role: 'status' })?.text, '15')

  // Another open panel added: the worker posts the new total.
  await view.post('counter.changed', { total: 20 })
  assert.equal(view.find({ role: 'status' })?.text, '20')
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})
`

const WORKER_TEST_TS = `// Runs src/worker.ts's activate(orca) with the orca object Orca passes, over a mock host.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'

test('adds to the stored total and tells open panels', async () => {
  const host = mockHost({ storage: { total: 2 } })
  const worker = await mountWorker(main, { host })
  assert.deepEqual(await worker.request('counter.get'), { total: 2 })
  assert.deepEqual(await worker.request('counter.add', { by: 3 }), { total: 5 })
  assert.deepEqual(worker.posts, [{ event: 'counter.changed', payload: { total: 5 } }])
  assert.deepEqual(host.data().storage, { total: 5 })
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})
`

/** A components panel and its own build-less TS worker, typed by one shared contract. */
export function workerPanel(input: PluginTemplateInput): PluginTemplate {
  return {
    description:
      'Components panel backed by its own TypeScript worker: requests, posts and storage, no build step (needs --approve to load)',
    files: {
      'orca-plugin.json': manifest(input, 'A sidebar panel and the worker that answers it.', {
        execution: 'trusted-worker',
        pluginApi: 1,
        main: 'src/worker.ts',
        contributes: {
          panels: [
            {
              id: input.id,
              title: input.name,
              icon: 'blocks',
              entry: 'src/panel.tsx',
              ui: 'components'
            }
          ]
        },
        capabilities: [{ kind: 'storage:own' }]
      }),
      'src/protocol.ts': PROTOCOL_TS,
      'src/worker.ts': WORKER_TS,
      'src/panel.tsx': PANEL_TSX,
      'src/panel.test.tsx': PANEL_TEST_TSX,
      'src/panel.check.ts': PANEL_CHECK_TS,
      'src/worker.test.ts': WORKER_TEST_TS,
      'tsconfig.json': json({ extends: `./${PLUGIN_TYPES_DIR}/tsconfig.json`, include: ['src'] }),
      'README.md': readme(
        input,
        `A right-sidebar panel (\`src/panel.tsx\`) and the plugin's own worker (\`src/worker.ts\`). The panel asks with \`plugin.request\`, the worker answers with \`orca.panels.handle\`, keeps the total in \`orca.storage\` and tells every open panel with \`orca.panels.post\`; \`src/protocol.ts\` types both sides. Orca transpiles both files when they load, so there is no build step: save and the panel or worker reloads (a worker reload drops its in-memory state, so keep what must last in storage). \`orca plugin test .\` runs \`src/panel.test.tsx\` and \`src/worker.test.ts\` in Node with \`orca/testing\`, and \`orca plugin check .\` renders the panel with the worker in each \`src/panel.check.ts\` scenario; \`npx tsc -p .\` type-checks against the typings \`orca plugin types .\` writes to \`${PLUGIN_TYPES_DIR}/\`. With the folder loaded, \`orca plugin dev request . counter.add --data '{"by":1}'\` calls the worker as the panel does.`
      ),
      ...COMMON_FILES
    }
  }
}
