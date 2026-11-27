import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { removeTreeSync } from '../../shared/file-write/windows-transient-lock-removal'
import { launchExternalEditor, resolveExternalEditorLaunchSpec } from './external-editor-launch'

describe.runIf(process.platform === 'win32')('custom editor command through cmd.exe', () => {
  it('delivers a spaced workspace path as one intact argument', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-editor-launch-'))
    try {
      const workspace = join(root, 'John Smith')
      mkdirSync(workspace)
      const probe = join(root, 'probe.cmd')
      const output = join(root, 'argv.txt')
      writeFileSync(probe, `@echo %*> "${output}"\r\n`)

      await launchExternalEditor(resolveExternalEditorLaunchSpec(`"${probe}" --flag`, workspace))

      // Node's default quoting reaches cmd as --flag \"...\John Smith\", which editors split in two.
      await vi.waitFor(
        () => expect(readFileSync(output, 'utf8').trim()).toBe(`--flag "${workspace}"`),
        { timeout: 10_000 }
      )
    } finally {
      removeTreeSync(root)
    }
  })
})
