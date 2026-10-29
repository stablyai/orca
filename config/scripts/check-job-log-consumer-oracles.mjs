import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

// Runtime bundling keeps independent consumer assertions outside shared project type graphs.
export async function loadAnsiConsumers(root = process.cwd()) {
  const entries = [
    ['parseAnsiSegments', 'renderer/src/components/editor/ipynb-ansi'],
    [
      'restoredSnapshotPaintsPrintableContent',
      'renderer/src/components/terminal-pane/restored-snapshot-coverage'
    ],
    ['parseCodexLoginAuthUrl', 'main/codex-accounts/codex-login-auth-url'],
    ['TerminalCommandPaint', 'main/runtime/terminal-command-paint'],
    ['claudePermissionSubject', 'main/claude/claude-permission-presentation'],
    ['terminalSafe', 'shared/terminal-safe-text'],
    [
      'createAutomationRunOutputSnapshotBuffer',
      'renderer/src/components/automations/automation-run-output-snapshot'
    ]
  ]
  const bundle = await build({
    stdin: {
      contents: entries
        .map(([name, filename]) => `export { ${name} } from './${filename}';`)
        .join('\n'),
      resolveDir: path.join(root, 'src'),
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false
  })
  const directory = await mkdtemp(path.join(os.tmpdir(), 'orca-check-log-consumers-'))
  try {
    const filename = path.join(directory, 'consumers.mjs')
    await writeFile(filename, bundle.outputFiles[0].text)
    const consumers = await import(pathToFileURL(filename).href)
    for (const [name] of entries) {
      assert.equal(typeof consumers[name], 'function', `Missing actual consumer: ${name}`)
    }
    return consumers
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
