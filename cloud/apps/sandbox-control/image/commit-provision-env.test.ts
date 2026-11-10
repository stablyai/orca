import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- plain .mjs helper (runs before dependencies are installed); no type declarations
import { commitProvisionEnv } from './commit-provision-env.mjs'
import { VM_SCRIPTS, provisionEnv, type BuildInputs } from './golden-image'

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url).href)

describe('commit-provision-env.mjs (source builds provision with the fetched commit\'s image files)', () => {
  it('matches provisionEnv for this checkout, so Worker-started and operator builds provision the same', () => {
    const manifest = JSON.parse(readFileSync(here('./golden-image.manifest.json'), 'utf8'))
    const vmScripts = Object.fromEntries(VM_SCRIPTS.map((name) => [name, readFileSync(here(`./vm/${name}`), 'utf8')])) as BuildInputs['vmScripts']
    const expected = provisionEnv({ manifest, provisionScript: '', vmScripts, buildId: 'x' })
    delete expected.ORCAD_BUNDLE_URL
    delete expected.ORCAD_BUNDLE_SHA256
    expect(commitProvisionEnv(here('.'))).toEqual(expected)
  })

  it('every image/vm file is a declared VM script and installed by provision (none silently left out)', () => {
    expect(readdirSync(here('./vm')).sort()).toEqual([...VM_SCRIPTS].sort())
    const loop = /for name in ([^;]+); do\n\s+var="ORCA_VM_SCRIPT_/.exec(readFileSync(here('./provision-golden.sh'), 'utf8'))
    expect(loop?.[1]?.trim().split(/\s+/).sort()).toEqual([...VM_SCRIPTS].sort())
  })
})
