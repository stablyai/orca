import { PLUGIN_EDITOR_FRAME_SINCE } from '../../shared/plugins/manifest/plugin-schema-field-docs'
import { PLUGIN_TYPES_DIR } from './plugin-type-files'
import {
  COMMON_FILES,
  json,
  manifest,
  readme,
  type PluginTemplate,
  type PluginTemplateInput
} from './plugin-template-files'

// The rich-editor recipe as a starting point: a TypeScript editor on `orca.document.session`, its
// sync tested in Node with `mockEditorHost`. Sandboxed frame code, so loading it needs `--approve`.

const MAIN_TS = `import { start } from './sync'

// Your editor's view. A library (a canvas, a diagram kit) goes here instead of the textarea:
// copy its ESM build into the plugin and import it by a relative path.
const text = document.createElement('textarea')
text.spellcheck = false
text.style.cssText =
  'box-sizing:border-box;width:100%;height:100vh;margin:0;padding:12px;border:0;resize:none;' +
  'font:13px ui-monospace,monospace;color:var(--orca-foreground);background:var(--orca-background)'
document.body.style.margin = '0'
document.body.append(text)

const doc = await start()
text.value = doc.value
text.readOnly = doc.readOnly
doc.onReplace((value) => {
  text.value = value
})
text.addEventListener('input', () => doc.change(text.value))
`

const SYNC_TS = `/** A stand-in merge for plain text: take the side that changed; when both did, keep theirs and
 *  then yours. Replace it with your format's merge (by element id, never by array position). */
export function mergeText(base: string, outside: string, mine: string): string {
  if (mine === base) {
    return outside
  }
  if (outside === base) {
    return mine
  }
  return \`\${outside}\\n\${mine}\`
}

/** The only code that talks to Orca: sends edits, keeps unsaved typing, merges outside writes. */
export function start() {
  const document = orca.document
  if (!document) {
    throw new Error('this file runs as a custom editor')
  }
  return document.session<string>({ merge: mergeText })
}
`

const SYNC_TEST_TS = `import { assert, mockEditorHost, test } from 'orca/testing'
import { start } from './sync'

test('merges an outside write that lands while an edit waits', async () => {
  const host = mockEditorHost({ text: 'first' })
  const doc = await start()
  doc.change('first\\nmine')
  host.replace('theirs') // an agent writes the file first
  await host.flush() // as a save: conflict, merge, resend
  assert.equal(host.text, 'theirs\\nfirst\\nmine')
  doc.dispose()
  host.dispose()
})
`

export function editor(input: PluginTemplateInput): PluginTemplate {
  const extension = `.${input.id}`
  return {
    description:
      'Custom editor in TypeScript on the document session, with a Node test (needs --approve to load)',
    files: {
      'orca-plugin.json': manifest(
        input,
        `Edits ${extension} files.`,
        {
          execution: 'sandboxed-ui',
          pluginApi: 1,
          contributes: {
            customEditors: [
              {
                id: input.id,
                title: input.name,
                extensions: [extension],
                entry: 'editor/main.ts',
                frame: 'isolated'
              }
            ]
          }
        },
        `>=${PLUGIN_EDITOR_FRAME_SINCE}`
      ),
      'editor/main.ts': MAIN_TS,
      'editor/sync.ts': SYNC_TS,
      'editor/sync.test.ts': SYNC_TEST_TS,
      'tsconfig.json': json({
        extends: `./${PLUGIN_TYPES_DIR}/tsconfig.json`,
        include: ['editor']
      }),
      'README.md': readme(
        input,
        `A custom editor for \`${extension}\` files, in TypeScript with no build step. \`editor/sync.ts\` keeps the file in step through \`orca.document.session\` (replace its stand-in \`mergeText\` with your format's merge), and \`editor/main.ts\` is the view. \`orca plugin test .\` runs \`editor/sync.test.ts\` in Node with \`mockEditorHost\`; \`orca plugin check .\` reads every file the editor loads; \`orca plugin shot <plugin-key> --editor <file>\` saves a PNG of it. \`"frame": "isolated"\` keeps it to the Orca desktop app. Loading it needs approval: \`orca plugin dev watch .\` prints the exact access and the \`--approve\` fingerprint.`
      ),
      ...COMMON_FILES
    }
  }
}
