import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  collectProtectedCopyKeys,
  main,
  PROTECTED_COPY_KEYS_PATH,
  protectedCopyMarker
} from './protected-copy-keys.mjs'

const ENGLISH = new Set([
  'trust.title',
  'trust.allow',
  'trust.copy.warning',
  'confirm.delete',
  'confirm.count_other',
  'native.quit',
  'pragma.badge',
  'nested.deep',
  'trust.reasons.network',
  'plain.title'
])

let dirs = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  dirs = []
})

function sourcesFrom(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'orca-protected-copy-'))
  dirs.push(root)
  const sources = new Map()
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(root, ...name.split('/'))
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, text)
    sources.set(file, text)
  }
  return sources
}

describe('protected copy markers', () => {
  it.each([
    ['security surface', '<DialogContent surface="security">'],
    ['security surface', '<SecuritySurface>'],
    ['destructive confirmation', '<DialogContent><Button variant="destructive">'],
    ['destructive confirmation', '<AlertDialogFooter><Button variant="destructive">'],
    ['native message box', 'await dialog.showMessageBox(window, options)'],
    ['pragma', '// @protected-copy: badge\nexport const x = 1']
  ])('marks a %s', (marker, text) => {
    expect(protectedCopyMarker(text)).toBe(marker)
  })

  it('leaves ordinary dialogs and destructive menu items unmarked', () => {
    expect(protectedCopyMarker('<DialogContent><Button>')).toBeNull()
    expect(protectedCopyMarker('<DropdownMenuItem variant="destructive">')).toBeNull()
  })
})

describe('collectProtectedCopyKeys', () => {
  it('protects every key a marked file or its sibling copy module names', () => {
    const sources = sourcesFrom({
      'dialogs/TrustDialog.tsx': `import { trustCopy } from './trust-copy'
import { plain } from '../plain/Plain'
<DialogContent surface="security">{translate('trust.title', 'Trust?')}{translate('trust.allow', 'Allow')}`,
      'dialogs/trust-copy.ts': `export const trustCopy = () => translate('trust.copy.warning', 'Careful')`,
      'plain/Plain.tsx': `export const plain = () => translate('plain.title', 'Title')`,
      'confirm/DeleteDialog.tsx': `<DialogContent><Button variant="destructive">{translate('confirm.delete', 'Delete')}{translate('confirm.count', '{{count}}', { count })}</Button>`,
      'main/prompt.ts': `dialog.showMessageBox({ buttons: [translateMain('native.quit', 'Quit')] })`,
      'badge.ts': `// @protected-copy: badge\nexport const b = () => translate('pragma.badge', 'Official')`,
      'other.tsx': `translate('nested.deep', 'Deep')`
    })

    expect(collectProtectedCopyKeys(sources, ENGLISH)).toEqual({
      keys: [
        'confirm.count',
        'confirm.delete',
        'native.quit',
        'pragma.badge',
        'trust.allow',
        'trust.copy.warning',
        'trust.title'
      ],
      prefixes: []
    })
  })

  it('keeps the actual direct Setup security contribution source-owned', async () => {
    const { collectSourceFiles } = await import('./verify-localization-catalog.mjs')
    const root = process.cwd()
    const directory = path.join(root, 'src/renderer/src/components/new-workspace')
    const sources = new Map(
      (await collectSourceFiles(root, directory)).map((file) => [file, readFileSync(file, 'utf8')])
    )
    const english = JSON.parse(
      readFileSync(path.join(root, 'src/renderer/src/i18n/locales/en.json'), 'utf8')
    )
    const paths = new Set()
    const flatten = (value, prefix = '') => {
      for (const [key, child] of Object.entries(value)) {
        const full = prefix ? `${prefix}.${key}` : key
        paths.add(full)
        if (typeof child === 'object' && child !== null) {
          flatten(child, full)
        }
      }
    }
    flatten(english)
    const contribution = collectProtectedCopyKeys(sources, paths)
    expect(contribution.keys.length).toBeGreaterThan(0)
    expect(contribution.prefixes).toEqual([])
    expect(
      contribution.keys.every(
        (key) =>
          key.startsWith('components.newWorkspace.directSetup.') ||
          key === 'components.newWorkspace.setupCheckFailed'
      )
    ).toBe(true)
    const { collectKeyLiterals } = await import('./verify-localization-extraction.mjs')
    const { isProtectedCopyPath } =
      await import('../../src/shared/plugins/languages/plugin-protected-copy.ts')
    const dialog = sources.get(path.join(directory, 'DirectWorkItemSetupDialog.tsx'))
    const evidence = collectKeyLiterals(dialog, { literals: new Set(), dynamicPrefixes: new Set() })
    expect(
      [...evidence.literals]
        .filter((key) => paths.has(key))
        .every((key) => contribution.keys.includes(key) && isProtectedCopyPath(key))
    ).toBe(true)
    for (const name of ['SetupCommandPreview.tsx', 'WorkspaceSetupChoice.tsx']) {
      const copy = collectKeyLiterals(sources.get(path.join(directory, name)), {
        literals: new Set(),
        dynamicPrefixes: new Set()
      })
      expect([...copy.literals].filter((key) => paths.has(key))).toEqual([])
    }
  })

  it('keeps dynamic key heads only when they are specific', () => {
    const sources = sourcesFrom({
      'Dialog.tsx': '<SecuritySurface>{translate(`trust.${id}`)}{translate(`trust.reasons.${x}`)}'
    })

    expect(collectProtectedCopyKeys(sources, ENGLISH).prefixes).toEqual(['trust.reasons.'])
  })
})

describe('protected copy check', () => {
  it('fails when a security dialog uses a key the generated list lacks, until synced', async () => {
    sourcesFrom({
      'src/renderer/src/i18n/locales/en.json': JSON.stringify({ trust: { allow: 'Allow' } }),
      'src/renderer/src/Dialog.tsx': `<SecuritySurface>{translate('trust.allow', 'Allow')}`,
      'src/main/ready.ts': '',
      [PROTECTED_COPY_KEYS_PATH.split(path.sep).join('/')]: '{}'
    })
    const root = dirs.at(-1)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})

    expect(await main(root, [])).toBe(1)
    expect(await main(root, ['--fix'])).toBe(0)
    expect(await main(root, [])).toBe(0)
    expect(JSON.parse(readFileSync(path.join(root, PROTECTED_COPY_KEYS_PATH), 'utf8'))).toEqual({
      keys: ['trust.allow'],
      prefixes: []
    })
  })
})
