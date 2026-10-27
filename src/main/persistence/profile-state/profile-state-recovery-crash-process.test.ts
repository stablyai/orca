import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { buildRecoveryCrashProcess } from './profile-state-recovery-crash-process'

it('bundles one process-host source graph into the isolated recovery fixture', () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-recovery-bundle-'))
  try {
    const { metafile } = buildRecoveryCrashProcess(root)
    const packageInputs = Object.keys(metafile.inputs).filter((file) =>
      file.includes('/process-host/')
    )
    expect(packageInputs).toContain('src/packages/process-host/src/run-process.ts')
    expect(packageInputs.every((file) => file.startsWith('src/packages/process-host/src/'))).toBe(
      true
    )
    const packageExternals = Object.values(metafile.outputs)
      .flatMap((output) => output.imports)
      .filter((entry) => entry.external && entry.path.startsWith('@orca/process-host'))
    expect(packageExternals).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
