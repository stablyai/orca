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
        height: calc(100vh - 48px);
        color: inherit;
        background: transparent;
        border: 1px solid var(--orca-border);
        font: 13px ui-monospace, monospace;
      }
      #notice {
        margin: 4px 0 0;
        min-height: 16px;
        color: var(--orca-destructive);
      }
    </style>
  </head>
  <body>
    <textarea id="text" spellcheck="false"></textarea>
    <p id="notice" role="status"></p>
    <script>
      const text = document.getElementById('text')
      const notice = document.getElementById('notice')
      // The session sends edits, keeps unaccepted typing, and answers Orca's save.
      orca.document.session().then((doc) => {
        text.value = doc.value
        text.readOnly = doc.readOnly
        doc.onReplace((value) => (text.value = value))
        let check = 0
        text.addEventListener('input', () => {
          doc.change(text.value)
          clearTimeout(check)
          // Once typing pauses, show a refused edit; your text stays either way.
          check = setTimeout(() => {
            doc.flush().then(
              () => (notice.textContent = ''),
              (error) => (notice.textContent = 'Not saved: ' + error.message)
            )
          }, 500)
        })
      })
    </script>
  </body>
</html>
`,
      'README.md': readme(
        input,
        `A custom editor for \`${extension}\` files. It runs in a sandboxed frame and talks to Orca only through \`window.orca\`. Loading it needs approval: \`orca plugin dev watch .\` prints the exact access and the \`--approve\` fingerprint.`
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
        'A right-sidebar panel. It runs in a sandboxed frame and calls host methods its `capabilities` allow through `window.orca`. Loading it needs approval: `orca plugin dev watch .` prints the exact access and the `--approve` fingerprint.'
      ),
      ...COMMON_FILES
    }
  }
}
