import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectPaneReachableFiles, findPaneRealmSafetyHits } from './check-pane-realm-safety.mjs'

const tempDirs = []

function fixture(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'orca-pane-realm-'))
  tempDirs.push(root)
  for (const [relativePath, source] of Object.entries(files)) {
    const file = path.join(root, relativePath)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, source)
  }
  return root
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { force: true, recursive: true })
  }
})

describe('pane realm import graph', () => {
  it('follows terminal pane imports into renderer runtime modules', () => {
    const files = collectPaneReachableFiles(process.cwd()).map((file) =>
      path.relative(process.cwd(), file).split(path.sep).join('/')
    )

    expect(files).toContain('src/renderer/src/components/terminal-pane/pty-connection.ts')
    expect(files).toContain('src/renderer/src/runtime/sync-runtime-graph.ts')
  })

  it('follows pane entry imports across renderer source directories', () => {
    const root = fixture({
      'src/renderer/src/components/Terminal.tsx': "import '../app-shell/unsafe'\n",
      'src/renderer/src/app-shell/unsafe.ts': 'export const unsafe = value instanceof HTMLElement\n'
    })

    const failures = findPaneRealmSafetyHits(root)

    expect(failures[0]?.hits).toEqual([
      'src/renderer/src/app-shell/unsafe.ts:1:export const unsafe = value instanceof HTMLElement'
    ])
  })

  it('scans markdown link dependencies used by terminal panes', () => {
    const root = fixture({
      'src/renderer/src/components/Terminal.tsx':
        "import './terminal-pane/terminal-file-open-routing'\n",
      'src/renderer/src/components/terminal-pane/terminal-file-open-routing.ts':
        "import { unsafe } from '@/components/editor/markdown-internal-links'\n",
      'src/renderer/src/components/editor/markdown-internal-links.ts':
        'export const unsafe = value instanceof HTMLElement\n'
    })

    const failures = findPaneRealmSafetyHits(root)

    expect(failures[0]?.hits).toEqual([
      'src/renderer/src/components/editor/markdown-internal-links.ts:1:export const unsafe = value instanceof HTMLElement'
    ])
  })

  it('scans webview registry dependencies used by terminal panes', () => {
    const root = fixture({
      'src/renderer/src/components/Terminal.tsx':
        "import './terminal-pane/use-terminal-pane-lifecycle'\n",
      'src/renderer/src/components/terminal-pane/use-terminal-pane-lifecycle.ts':
        "import { unsafe } from '../browser-pane/webview-registry'\n",
      'src/renderer/src/components/browser-pane/webview-registry.ts':
        'export const unsafe = document.activeElement\n'
    })

    const failures = findPaneRealmSafetyHits(root)

    expect(failures[0]?.hits).toEqual([
      'src/renderer/src/components/browser-pane/webview-registry.ts:1:export const unsafe = document.activeElement'
    ])
  })

  it('resolves aliases, TSX index files, re-exports, and cycles', () => {
    const root = fixture({
      'src/renderer/src/entry.ts': "import '@/pane'\n",
      'src/renderer/src/pane/index.tsx': "export { unsafe } from './floating'\n",
      'src/renderer/src/pane/floating.ts':
        "import './cycle'\nexport const unsafe = (value) => value instanceof HTMLElement\n",
      'src/renderer/src/pane/cycle.ts': "import './floating'\n"
    })

    const options = {
      scopes: [],
      entries: ['src/renderer/src/entry.ts'],
      sourceRoots: ['src/renderer/src']
    }
    const files = collectPaneReachableFiles(root, options).map((file) =>
      path.relative(root, file).split(path.sep).join('/')
    )
    const failures = findPaneRealmSafetyHits(root, options)

    expect(files).toEqual([
      'src/renderer/src/entry.ts',
      'src/renderer/src/pane/cycle.ts',
      'src/renderer/src/pane/floating.ts',
      'src/renderer/src/pane/index.tsx'
    ])
    expect(failures[0]?.hits).toEqual([
      'src/renderer/src/pane/floating.ts:2:export const unsafe = (value) => value instanceof HTMLElement'
    ])
  })

  it('does not traverse package imports or test files', () => {
    const root = fixture({
      'src/renderer/src/entry.ts': "import 'react'\nimport './entry.test'\n",
      'src/renderer/src/entry.test.ts': 'value instanceof HTMLElement\n'
    })

    expect(
      findPaneRealmSafetyHits(root, {
        scopes: [],
        entries: ['src/renderer/src/entry.ts'],
        sourceRoots: ['src/renderer/src']
      })
    ).toEqual([])
  })

  it('follows static CommonJS requires', () => {
    const root = fixture({
      'src/renderer/src/entry.cjs': "require('./unsafe')\n",
      'src/renderer/src/unsafe.cjs': 'module.exports = value instanceof HTMLElement\n'
    })

    const failures = findPaneRealmSafetyHits(root, {
      scopes: [],
      entries: ['src/renderer/src/entry.cjs'],
      sourceRoots: ['src/renderer/src']
    })

    expect(failures[0]?.hits).toEqual([
      'src/renderer/src/unsafe.cjs:1:module.exports = value instanceof HTMLElement'
    ])
  })

  it('rejects opener-realm CompositionEvent checks', () => {
    const root = fixture({
      'src/renderer/src/entry.ts':
        'export const composition = (event) => event instanceof CompositionEvent\n'
    })

    const failures = findPaneRealmSafetyHits(root, {
      scopes: [],
      entries: ['src/renderer/src/entry.ts'],
      sourceRoots: ['src/renderer/src']
    })

    expect(failures[0]?.hits).toEqual([
      'src/renderer/src/entry.ts:1:export const composition = (event) => event instanceof CompositionEvent'
    ])
  })
})
