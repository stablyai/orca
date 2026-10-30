import {
  COMMON_FILES,
  manifest,
  readme,
  type PluginTemplate,
  type PluginTemplateInput
} from './plugin-template-files'

// Sandboxed-frame templates: they run code, so loading them needs `--approve`.

const FRAME_STYLE = `body {
        margin: 0;
        padding: 12px;
        font: 13px system-ui, sans-serif;
        color: var(--orca-foreground);
        background: var(--orca-background);
      }`

export function editor(input: PluginTemplateInput): PluginTemplate {
  const extension = `.${input.id.replace(/[^a-z0-9]/g, '').slice(0, 12) || 'note'}`
  return {
    description: 'Custom editor for a file type, in a sandboxed frame (needs --approve to load)',
    files: {
      'orca-plugin.json': manifest(input, `Edits ${extension} files.`, {
        execution: 'sandboxed-ui',
        pluginApi: 1,
        contributes: {
          customEditors: [
            {
              id: input.id,
              title: input.name,
              extensions: [extension],
              entry: 'editor/index.html'
            }
          ]
        }
      }),
      'editor/index.html': `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      ${FRAME_STYLE}
      textarea {
        box-sizing: border-box;
        width: 100%;
        height: calc(100vh - 24px);
        color: inherit;
        background: transparent;
        border: 1px solid var(--orca-border);
        font: 13px ui-monospace, monospace;
      }
    </style>
  </head>
  <body>
    <textarea id="text" spellcheck="false"></textarea>
    <script>
      const text = document.getElementById('text')
      let version = 0
      // Orca sends the document now and again whenever the file changes outside the editor.
      orca.document.onDidChange((doc) => {
        version = doc.version
        text.readOnly = doc.readOnly
        if (doc.content.kind === 'text' && text.value !== doc.content.text) {
          text.value = doc.content.text
        }
      })
      text.addEventListener('input', () => {
        void orca.document
          .applyEdit({ baseVersion: version, content: { kind: 'text', text: text.value } })
          .catch((error) => console.warn(error.code, error.message))
      })
    </script>
  </body>
</html>
`,
      'README.md': readme(
        input,
        `A custom editor for \`${extension}\` files. It runs in a sandboxed frame and talks to Orca only through \`window.orca\`. Loading it needs approval: \`orca plugin dev load\` prints the exact access and the \`--approve\` fingerprint.`
      ),
      ...COMMON_FILES
    }
  }
}

export function panel(input: PluginTemplateInput): PluginTemplate {
  return {
    description: 'Right-sidebar panel in a sandboxed frame (needs --approve to load)',
    files: {
      'orca-plugin.json': manifest(input, 'A sidebar panel.', {
        execution: 'sandboxed-ui',
        pluginApi: 1,
        contributes: {
          panels: [{ id: input.id, title: input.name, icon: 'puzzle', entry: 'panel/index.html' }]
        },
        capabilities: [{ kind: 'workspace:read' }]
      }),
      'panel/index.html': `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      ${FRAME_STYLE}
    </style>
  </head>
  <body>
    <h1>${input.name.replace(/[<>&]/g, '')}</h1>
    <p id="workspace">Loading…</p>
    <script>
      const label = document.getElementById('workspace')
      async function refresh() {
        if (!orca.host.has('workspace.readContext')) {
          label.textContent = 'This Orca cannot read workspace context.'
          return
        }
        try {
          const context = await orca.host.call('workspace.readContext', {})
          label.textContent = JSON.stringify(context, null, 2)
        } catch (error) {
          label.textContent = error.code + ': ' + error.message
        }
      }
      void refresh()
    </script>
  </body>
</html>
`,
      'README.md': readme(
        input,
        'A right-sidebar panel. It runs in a sandboxed frame and calls host methods its `capabilities` allow through `window.orca`. Loading it needs approval: `orca plugin dev load` prints the exact access and the `--approve` fingerprint.'
      ),
      ...COMMON_FILES
    }
  }
}
