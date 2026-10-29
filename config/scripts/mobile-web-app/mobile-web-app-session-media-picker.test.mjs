// Inspect session module closure using web resolution, matching what page bundles.
// Native image/document pickers throw on browser import, breaking whole manifest; clipboard image read needs secure context absent under iOS scheme.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { mobileWebAppRouteClosure } from '../build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import {
  MEDIA_PICKER_SEAM as SEAM,
  mediaPickerOffenders,
  mediaPickerSites
} from './platform-seams/mobile-web-app-media-picker-seam.mjs'

const mobileDir = fileURLToPath(new URL('../../../mobile/', import.meta.url))
const describeClosure = mobileWebAppDependenciesPresent() ? describe : describe.skip

const SESSION = 'app/h/[hostId]/session/[worktreeId].tsx'

describeClosure(
  'the session page closure',
  () => {
    it('reaches no picker but the seam', async () => {
      const closure = await mobileWebAppRouteClosure(SESSION)
      expect(mediaPickerOffenders(mobileDir, closure)).toEqual([])
    })

    it('carries the seam, so the rule above is not vacuous', async () => {
      const closure = await mobileWebAppRouteClosure(SESSION)
      expect(closure.local).toContain(SEAM)
      // Require native picker chain excluded entirely, rather than merely unused after import.
      expect(closure.local).not.toContain('src/platform/media-picker.ts')
      expect(closure.local).not.toContain('src/session/mobile-image-source-picker.ts')
    })

    it('carries none of the three native media modules at all', async () => {
      const closure = await mobileWebAppRouteClosure(SESSION)
      // Seam and canvas resize must remove native picker/file-system packages whose web builds are absent or stubbed.
      for (const absent of ['expo-image-picker', 'expo-document-picker', 'expo-file-system']) {
        expect(
          closure.modules.filter((module) => module.includes(`/${absent}/`)),
          absent
        ).toEqual([])
      }
      expect(closure.local).toContain('src/session/mobile-clipboard-image-resize.ts')
    })
  },
  240_000
)

// Synthetic modules prove future picker calls are detected without flagging allowed expo-clipboard text reads.
describe('the rule that reads a module for a picker', () => {
  const PLANTED = {
    'namespace-picker.ts':
      "import * as ImagePicker from 'expo-image-picker'\nexport const p = ImagePicker",
    'documents.ts':
      "import { getDocumentAsync } from 'expo-document-picker'\nexport const d = getDocumentAsync",
    'side-effect.ts': "import 'expo-image-picker'",
    're-export.ts': "export { getImageAsync } from 'expo-clipboard'",
    'clipboard-image.ts':
      "import * as Clipboard from 'expo-clipboard'\nexport const r = () => Clipboard.getImageAsync({ format: 'png' })",
    'renamed-image-read.ts':
      "import { getImageAsync as readImage } from 'expo-clipboard'\nexport const r = readImage",
    'destructured.ts':
      "import * as Clipboard from 'expo-clipboard'\nconst { getImageAsync } = Clipboard\nexport const r = getImageAsync",
    'destructured-renamed.ts':
      "import * as Clipboard from 'expo-clipboard'\nconst { getImageAsync: readImage } = Clipboard\nexport const r = readImage",
    're-destructured.ts':
      "import * as Clipboard from 'expo-clipboard'\nconst pasteboard = Clipboard\nconst again = pasteboard\nconst { getImageAsync } = again\nexport const r = getImageAsync",
    'element-access.ts':
      "import * as Clipboard from 'expo-clipboard'\nexport const r = () => Clipboard['getImageAsync']({ format: 'png' })",
    'template-access.ts':
      "import * as Clipboard from 'expo-clipboard'\nexport const r = () => Clipboard[`getImageAsync`]({ format: 'png' })",
    // Variable-held key is unknown: identifier named for image method holds text method to catch false literal inference.
    'computed-access.ts':
      "import * as Clipboard from 'expo-clipboard'\nconst getImageAsync = 'getStringAsync'\nexport const r = () => Clipboard[getImageAsync]()",
    // Reverse alias declaration order exercises fixed-point learning; deferred function use is runtime-valid.
    'reverse-order-alias.ts':
      "import * as Clipboard from 'expo-clipboard'\nexport function read() {\n  const { getImageAsync } = first\n  return getImageAsync\n}\nconst first = second\nconst second = Clipboard",
    // Dynamic import belongs to bundler closure too, beyond static source scan.
    'dynamic-clipboard.ts':
      "export async function r() {\n  const Clipboard = await import('expo-clipboard')\n  return Clipboard.getImageAsync({ format: 'png' })\n}",
    'dynamic-destructured.ts':
      "export async function r() {\n  const { getImageAsync } = await import('expo-clipboard')\n  return getImageAsync({ format: 'png' })\n}",
    'dynamic-picker.ts':
      "export async function r() {\n  return await import('expo-image-picker')\n}",
    // Template specifier without substitutions is static to bundler.
    'dynamic-template-picker.ts':
      'export async function r() {\n  return await import(`expo-image-picker`)\n}',
    'dynamic-clipboard-text.ts':
      "export async function r() {\n  const Clipboard = await import('expo-clipboard')\n  return Clipboard.getStringAsync()\n}",
    'clipboard-text.ts':
      "import * as Clipboard from 'expo-clipboard'\nexport const r = () => Clipboard.getStringAsync()",
    'destructured-text.ts':
      "import * as Clipboard from 'expo-clipboard'\nconst { getStringAsync } = Clipboard\nexport const r = getStringAsync",
    'mentions-only.ts':
      "// expo-image-picker and Clipboard.getImageAsync are reached through the seam\nexport const note = 'expo-document-picker'"
  }

  it('names every way in and nothing else', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'orca-session-media-picker-'))
    try {
      mkdirSync(join(scratch, 'src'), { recursive: true })
      for (const [name, source] of Object.entries(PLANTED)) {
        writeFileSync(join(scratch, 'src', name), source)
      }
      const closure = { local: Object.keys(PLANTED).map((name) => `src/${name}`) }
      expect(mediaPickerOffenders(scratch, closure)).toEqual([
        'src/clipboard-image.ts:2',
        'src/destructured-renamed.ts:2',
        'src/destructured.ts:2',
        'src/documents.ts:1',
        'src/dynamic-clipboard.ts:3',
        'src/dynamic-destructured.ts:2',
        'src/dynamic-picker.ts:2',
        'src/dynamic-template-picker.ts:2',
        'src/element-access.ts:2',
        'src/namespace-picker.ts:1',
        'src/re-destructured.ts:4',
        'src/re-export.ts:1',
        'src/renamed-image-read.ts:1',
        'src/reverse-order-alias.ts:3',
        'src/side-effect.ts:1',
        'src/template-access.ts:2'
      ])
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  it('reads a .ts generic arrow as TypeScript, so nothing after one is swallowed', () => {
    const source =
      "import * as Clipboard from 'expo-clipboard'\n" +
      'export const id = <T,>(value: T) => value\n' +
      'export const r = () => Clipboard.getImageAsync({ format: "png" })\n'
    expect(mediaPickerSites(source, 'src/generic.ts')).toEqual([3])
  })

  it('exempts the seam itself, which is the one module allowed to reach them', () => {
    expect(mediaPickerOffenders(mobileDir, { local: [SEAM] })).toEqual([])
  })
})
