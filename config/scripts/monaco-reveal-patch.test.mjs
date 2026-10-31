import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { runProcessSync } from '@orca/process-host'
import { removeTreeSync } from '../../src/shared/windows-transient-lock-removal.ts'
import { resolvePnpmCliInvocation } from './pnpm-cli-invocation.mjs'

it('installs the reveal contract and refuses a version bump that leaves its patch unused', () => {
  const project = resolve(import.meta.dirname, '../..')
  const workspace = readFileSync(join(project, 'pnpm-workspace.yaml'), 'utf8')
  const [, version, patch] = workspace.match(/^  monaco-editor@([^:]+): (.+)$/m) ?? []
  expect(version).toBeTruthy()
  expect(workspace).toContain('allowUnusedPatches: false')
  const scratch = mkdtempSync(join(tmpdir(), 'orca-monaco-reveal-'))
  const { command, prefixArgs } = resolvePnpmCliInvocation()
  const install = () =>
    runProcessSync({
      program: command,
      args: [...prefixArgs, 'install', '--no-frozen-lockfile', '--ignore-scripts'],
      cwd: scratch,
      timeoutMs: 300_000
    })
  try {
    mkdirSync(join(scratch, 'config/patches'), { recursive: true })
    copyFileSync(join(project, patch), join(scratch, patch))
    const manifest = (selected) =>
      JSON.stringify({
        name: 'orca-reveal-contract',
        version: '1.0.0',
        dependencies: { 'monaco-editor': selected }
      })
    writeFileSync(join(scratch, 'package.json'), manifest(version))
    writeFileSync(
      join(scratch, 'pnpm-workspace.yaml'),
      `packages: []\nallowUnusedPatches: false\npatchedDependencies:\n  monaco-editor@${version}: ${patch}\n`
    )
    const installed = install()
    expect(installed.code, `${installed.stdout}\n${installed.stderr}`).toBe(0)
    const esm = join(scratch, 'node_modules/monaco-editor/esm/vs/editor')
    const widget = readFileSync(join(esm, 'browser/widget/codeEditor/codeEditorWidget.js'), 'utf8')
    expect(widget).toContain('this.onDidRequestReveal =')
    expect(widget).toContain("kind: 'save'")
    expect(widget).toContain("kind: 'restore'")
    expect(
      readFileSync(
        join(esm, 'browser/widget/diffEditor/features/hideUnchangedRegionsFeature.js'),
        'utf8'
      )
    ).toContain("kind: 'anchor'")
    const find = readFileSync(join(esm, 'contrib/find/browser/findController.js'), 'utf8')
    expect(find).toContain("kind: 'find'")
    expect(find).toContain('this._start(opts, newState).then(')
    expect(readFileSync(join(esm, 'editor.api.d.ts'), 'utf8')).toContain('onDidRequestReveal:')
    expect(readFileSync(join(esm, 'editor.api.d.ts'), 'utf8')).toContain('height: number')
    writeFileSync(join(scratch, 'package.json'), manifest('0.54.0'))
    const unused = install()
    expect(unused.code).not.toBe(0)
    expect(`${unused.stdout}\n${unused.stderr}`).toContain('ERR_PNPM_UNUSED_PATCH')
  } finally {
    removeTreeSync(scratch)
  }
}, 600_000)
