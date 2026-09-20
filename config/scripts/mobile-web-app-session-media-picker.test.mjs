/**
 * What the session screen may reach to pick media, which is what its media grants are declared
 * against.
 *
 * The route is not registered yet (C7.7 registers it), so this walks the route module's own closure
 * rather than a page route's. The bundler resolves it exactly as it would a registered one — a
 * `.web.ts` sibling wins — so the modules judged here are the ones the page would run.
 *
 * `expo-image-picker` and `expo-document-picker` throw at import in a browser and the manifest
 * imports every route, so one of them in this closure is the whole bundle down rather than one
 * picker; `expo-clipboard`'s `getImageAsync` resolves instead to a `navigator.clipboard` read
 * needing a secure context, which the iOS shell's custom scheme is not.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { mobileWebAppRouteClosure } from './build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import {
  MEDIA_PICKER_SEAM as SEAM,
  mediaPickerOffenders,
  mediaPickerSites
} from './mobile-web-app-media-picker-seam.mjs'

const mobileDir = fileURLToPath(new URL('../../mobile/', import.meta.url))
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
      // And not the native picker chain it stands in for: the two modules that reach the OS
      // pickers resolve out of this closure entirely rather than sitting in it unused.
      expect(closure.local).not.toContain('src/platform/media-picker.ts')
      expect(closure.local).not.toContain('src/session/mobile-image-source-picker.ts')
    })

    it('carries none of the four native media modules at all', async () => {
      const closure = await mobileWebAppRouteClosure(SESSION)
      // Beyond the source rule: the seam and the canvas resize together take the pickers, the
      // manipulator and the file system out of the bundle rather than leaving them in it unused.
      // Each is a native module whose web build is absent or a stub, and `expo-file-system` was
      // here only to read a picked file and to hold the manipulator's temp PNG.
      for (const absent of [
        'expo-image-picker',
        'expo-document-picker',
        'expo-image-manipulator',
        'expo-file-system'
      ]) {
        expect(
          closure.modules.filter((module) => module.includes(`/${absent}/`)),
          absent
        ).toEqual([])
      }
      expect(closure.local).toContain('src/session/mobile-clipboard-image-resize.web.ts')
    })

    it('is big enough that finding nothing would mean something', async () => {
      const closure = await mobileWebAppRouteClosure(SESSION)
      // The largest route of the series; a closure that collapsed would pass every rule above by
      // containing nothing to judge.
      expect(closure.local.length).toBeGreaterThan(900)
    })
  },
  240_000
)

/**
 * The rule itself, against modules planted in a scratch tree.
 *
 * A scan that happens to find today's three call sites is not a scan that would find a fourth, and
 * the negatives matter as much: this closure is full of `expo-clipboard` text reads that are the
 * clipboard seam's business and not this one's.
 */
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
    // A key held in a variable is not read: its value is not at the call site, and a census
    // reporting a line nobody can act on is one the next reader learns to ignore. The variable is
    // named after the method and holds a different one, so a rule that read the identifier's text
    // instead of a literal's would report a call that reads text.
    'computed-access.ts':
      "import * as Clipboard from 'expo-clipboard'\nconst getImageAsync = 'getStringAsync'\nexport const r = () => Clipboard[getImageAsync]()",
    // Deliberately back to front: the alias `first` reads from `second`, which is only learned
    // further down. Valid at run time, because the destructure is inside a function the module
    // body has finished before anything calls. A walk that learned aliases in source order would
    // never reach `first`, and this is the fixture that says so.
    'reverse-order-alias.ts':
      "import * as Clipboard from 'expo-clipboard'\nexport function read() {\n  const { getImageAsync } = first\n  return getImageAsync\n}\nconst first = second\nconst second = Clipboard",
    // Reached through `import()`, which the bundler resolves into the closure exactly as a static
    // import: the same two modules, the same offence, a form the static scan cannot see.
    'dynamic-clipboard.ts':
      "export async function r() {\n  const Clipboard = await import('expo-clipboard')\n  return Clipboard.getImageAsync({ format: 'png' })\n}",
    'dynamic-destructured.ts':
      "export async function r() {\n  const { getImageAsync } = await import('expo-clipboard')\n  return getImageAsync({ format: 'png' })\n}",
    'dynamic-picker.ts':
      "export async function r() {\n  return await import('expo-image-picker')\n}",
    // A backticked specifier without substitutions is as static as the quoted one to the bundler.
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
