import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { mobileWebAppModuleClosure } from './build-mobile-web-app-bundle.mjs'

it('resolves local entry paths against the requested tree and selects browser siblings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-route-entrypoints-'))
  const modules = ['app/_layout', 'app/h/_layout', 'app/h/[hostId]/index']
  const expected = [
    'app/_layout.web.tsx',
    'app/h/_layout.tsx',
    'app/h/[hostId]/browser-dependency.ts',
    'app/h/[hostId]/index.web.tsx'
  ].sort()
  try {
    await mkdir(join(root, 'app/h/[hostId]'), { recursive: true })
    await writeFile(join(root, 'app/_layout.tsx'), "import 'native-only-layout'")
    await writeFile(join(root, 'app/_layout.web.tsx'), 'export const layout = true')
    await writeFile(join(root, 'app/h/_layout.tsx'), 'export const nestedLayout = true')
    await writeFile(join(root, 'app/h/[hostId]/index.tsx'), "import 'native-only-package'")
    await writeFile(join(root, 'app/h/[hostId]/index.web.tsx'), "import './browser-dependency'")
    await writeFile(
      join(root, 'app/h/[hostId]/browser-dependency.ts'),
      'export const browser = true'
    )
    for (const entries of [
      modules,
      modules.map((entry) => `${entry}.tsx`),
      modules.map((entry) => `./${entry}.tsx`),
      modules.map((entry) => join(root, `${entry}.tsx`))
    ]) {
      const { local } = await mobileWebAppModuleClosure(entries, { absWorkingDir: root })
      expect(local.map((file) => file.replaceAll('\\', '/')).sort()).toEqual(expected)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
