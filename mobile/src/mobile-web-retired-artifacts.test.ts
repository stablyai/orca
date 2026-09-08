import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { extname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const productionRoots = [
  new URL('../app/hybrid.tsx', import.meta.url),
  new URL('./mobile-web', import.meta.url),
  new URL('../host-web-app', import.meta.url),
  new URL('../../src/mobile-web', import.meta.url),
  new URL('../../src/shared/mobile-web', import.meta.url),
  new URL('../../src/main/runtime/rpc/methods/mobile-web-package.ts', import.meta.url),
  new URL('../../src/main/runtime/rpc/mobile-web-package-assets.ts', import.meta.url),
  new URL('../../src/main/runtime/rpc/mobile-web-package-root.ts', import.meta.url)
]

const forbiddenProductionReferences = [
  'hybrid-prototype',
  'mobile-web-prototype',
  'MobileWebPrototype',
  'mobileWeb.prototype'
]
const standaloneClientRoot = new URL('../../src/mobile-web', import.meta.url)
const retiredStandaloneArtifacts = [
  new URL('../../src/mobile-web/index.html', import.meta.url),
  new URL('../../src/mobile-web/src/entry.tsx', import.meta.url),
  new URL('../../src/mobile-web/src/mobile-web-shell.tsx', import.meta.url),
  new URL('../../vite.mobile-web.config.ts', import.meta.url),
  new URL('../../config/scripts/verify-mobile-web-build.mjs', import.meta.url),
  new URL('../../build-plugins/mobile-web-content-addressed.ts', import.meta.url),
  new URL('../../build-plugins/mobile-web-import-boundary.ts', import.meta.url),
  new URL('../../build-plugins/mobile-web-style-boundary.ts', import.meta.url)
]

function sourceFiles(root: URL): URL[] {
  if (extname(root.pathname)) {
    return [root]
  }
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const child = new URL(`${root.href.replace(/\/$/, '')}/${entry.name}`)
    if (entry.isDirectory()) {
      return sourceFiles(child)
    }
    return /\.(?:ts|tsx)$/.test(entry.name) ? [child] : []
  })
}

describe('mobile web retired artifacts', () => {
  it('keeps prototype contracts and names out of production sources', () => {
    const violations = productionRoots.flatMap(sourceFiles).flatMap((file) => {
      const source = readFileSync(file, 'utf8')
      return forbiddenProductionReferences
        .filter((reference) => source.includes(reference))
        .map((reference) => `${join(...file.pathname.split('/').slice(-4))}: ${reference}`)
    })

    expect(violations).toEqual([])
  })

  it('keeps the retired standalone presentation out of production', () => {
    expect(retiredStandaloneArtifacts.filter((artifact) => existsSync(artifact))).toEqual([])
    const rendererImports = sourceFiles(standaloneClientRoot).flatMap((file) => {
      const source = readFileSync(file, 'utf8')
      return source.includes('@renderer') || source.includes('src/renderer') ? [file.pathname] : []
    })

    expect(rendererImports).toEqual([])
  })

  it('keeps the superseded prototype architecture removed', () => {
    const retiredPrototypeArtifacts = [
      new URL('../app/hybrid-prototype.tsx', import.meta.url),
      new URL('./hybrid-prototype', import.meta.url),
      new URL('../../src/shared/mobile-web-prototype-contract.ts', import.meta.url),
      new URL('../../src/main/runtime/rpc/methods/mobile-web-prototype.ts', import.meta.url),
      new URL('../../src/main/runtime/rpc/mobile-web-prototype-assets.ts', import.meta.url),
      new URL('../../src/main/runtime/rpc/mobile-web-prototype-document.ts', import.meta.url)
    ]

    expect(retiredPrototypeArtifacts.filter((artifact) => existsSync(artifact))).toEqual([])
  })
})
