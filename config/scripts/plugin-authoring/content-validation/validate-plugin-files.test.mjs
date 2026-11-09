import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { runProcess } from '@orca/process-host'
import { afterEach, describe, expect, it } from 'vitest'
import { createPluginFromTemplate } from '../../../../src/cli/plugin-authoring/plugin-create'

const SCRIPT = path.join(import.meta.dirname, './validate-plugin-files.mjs')
const roots = []

async function tempRoot() {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-validate-plugin-files-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function validate(...targets) {
  return runProcess({
    program: process.execPath,
    args: [SCRIPT, ...targets],
    timeoutMs: 60_000
  })
}

describe('validate-plugin-files', () => {
  it('fails with exit 1 when a file the manifest names is missing', async () => {
    const dir = path.join(await tempRoot(), 'panel')
    await createPluginFromTemplate({ dir, template: 'panel', publisher: 'acme' })
    await rm(path.join(dir, 'panel', 'index.html'))
    const result = await validate(dir)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('panel/index.html')
  }, 60_000)
})
