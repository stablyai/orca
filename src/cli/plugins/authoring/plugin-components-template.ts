import {
  COMMON_FILES,
  json,
  manifest,
  readme,
  type PluginTemplate,
  type PluginTemplateInput
} from './plugin-template-files'
import { PLUGIN_TYPES_DIR } from './plugin-type-files'

const PANEL_TSX = `import { atom, Badge, Button, Heading, Row, Stack, Text, read, set, update } from 'orca'

const count = atom(0)

export default function Panel() {
  const value = read(count)
  return (
    <Stack gap="md">
      <Row justify="between">
        <Heading>Counter</Heading>
        <Badge tone={value > 0 ? 'accent' : 'neutral'}>{value}</Badge>
      </Row>
      <Row gap="xs">
        <Button onPress={() => update(count, (n) => n + 1)}>Add one</Button>
        <Button variant="ghost" onPress={() => set(count, 0)}>
          Reset
        </Button>
      </Row>
      <Text muted size="xs">
        Edit src/panel.tsx and save: Orca reloads the panel. No build step.
      </Text>
    </Stack>
  )
}
`

const PANEL_TEST_TSX = `// \`orca plugin test .\` runs this in Node with the same runtime and checks Orca uses.
import { assert, mount, test } from 'orca/testing'
import * as panel from './panel'

test('counts presses and resets', async () => {
  const view = await mount(panel)
  assert.equal(view.find({ role: 'status' })?.text, '0')

  await view.press({ text: 'Add one' })
  await view.press({ text: 'Add one' })
  assert.equal(view.find({ role: 'status' })?.text, '2')

  await view.press({ text: 'Reset' })
  assert.equal(view.find({ role: 'status' })?.text, '0')
  assert.deepEqual(view.errors, [])
  await view.unmount()
})
`

/** Build-less TSX panel: Orca transpiles src/panel.tsx when the panel loads. */
export function components(input: PluginTemplateInput): PluginTemplate {
  return {
    description:
      'Right-sidebar panel written in TSX with Orca components, no build step (needs --approve to load)',
    files: {
      'orca-plugin.json': manifest(input, 'A sidebar panel built from Orca components.', {
        execution: 'sandboxed-ui',
        pluginApi: 1,
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
        }
      }),
      'src/panel.tsx': PANEL_TSX,
      'src/panel.test.tsx': PANEL_TEST_TSX,
      'tsconfig.json': json({ extends: `./${PLUGIN_TYPES_DIR}/tsconfig.json`, include: ['src'] }),
      'README.md': readme(
        input,
        `A right-sidebar panel written in TSX. Orca transpiles \`src/panel.tsx\` when the panel loads, so there is no build step and no build folder: edit, save, and the panel reloads. \`orca plugin types .\` (also run by \`orca plugin dev watch\`) writes the editor typings to \`${PLUGIN_TYPES_DIR}/\`, which \`tsconfig.json\` extends; run \`npx tsc -p .\` to type-check. \`orca plugin test .\` runs \`src/panel.test.tsx\` in Node with \`orca/testing\`, and \`orca plugin check .\` renders the panel once and reports errors with file:line. Import only \`orca\` and relative files.`
      ),
      ...COMMON_FILES
    }
  }
}
