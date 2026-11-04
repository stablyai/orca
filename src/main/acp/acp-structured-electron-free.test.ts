// Bundled relative-source imports must not reach Electron; external package internals are excluded.

import { resolve } from 'node:path'
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'

describe('ACP structured lane', () => {
  it('bundles the adapter, launch resolution and agent rows without relative-source Electron imports', async () => {
    const result = await build({
      entryPoints: [
        resolve(__dirname, 'acp-structured-session-adapter.ts'),
        resolve(__dirname, 'acp-structured-launch-resolution.ts'),
        resolve(__dirname, 'acp-agent-connection.ts'),
        resolve(__dirname, 'acp-launch-specs.ts')
      ],
      bundle: true,
      write: false,
      outdir: 'out',
      platform: 'node',
      format: 'esm',
      target: 'node22',
      packages: 'external',
      metafile: true,
      logLevel: 'silent'
    })
    const imports = Object.values(result.metafile.outputs).flatMap((output) =>
      output.imports.map((entry) => entry.path)
    )
    expect(imports.filter((path) => path === 'electron' || path.startsWith('electron/'))).toEqual(
      []
    )
  }, 60_000)
})
