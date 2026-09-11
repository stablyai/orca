import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import ts from 'typescript'

// Exercise the actual layout callback without loading native notification and navigation modules.
const source = ts.createSourceFile(
  '_layout.tsx',
  readFileSync(resolve(import.meta.dirname, '../../app/_layout.tsx'), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
)
let callback: string | undefined
function visit(node: ts.Node): void {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'onNavigatorLayout') {
    callback = (node.initializer as ts.CallExpression).arguments[0].getText(source)
  }
  ts.forEachChild(node, visit)
}
visit(source)

function startup(load: () => Promise<unknown>, hide: () => Promise<void>) {
  if (!callback) {
    throw new Error('Root layout must coordinate the native splash')
  }
  return new Function('loadMobileTerminalThemeMode', 'SplashScreen', `return (${callback})`)(load, {
    hideAsync: hide
  }) as () => Promise<void>
}

describe('terminal appearance before native splash dismissal', () => {
  it('waits for saved appearance before exposing the first frame', async () => {
    let resolveLoad!: () => void
    const load = new Promise<void>((resolve) => {
      resolveLoad = resolve
    })
    const hide = vi.fn().mockResolvedValue(undefined)
    const ready = startup(() => load, hide)()
    expect(hide).not.toHaveBeenCalled()
    resolveLoad()
    await ready
    expect(hide).toHaveBeenCalledOnce()
  })

  it('reports a storage failure and still dismisses the splash', async () => {
    const error = new Error('storage unavailable')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const hide = vi.fn().mockResolvedValue(undefined)
    try {
      await startup(() => Promise.reject(error), hide)()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('terminal appearance'), error)
      expect(hide).toHaveBeenCalledOnce()
    } finally {
      warn.mockRestore()
    }
  })
})
