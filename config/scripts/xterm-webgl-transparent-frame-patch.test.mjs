import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const projectDir = resolve(import.meta.dirname, '../..')
const packageDir = join(projectDir, 'node_modules', '@xterm', 'addon-webgl')
const transparentClearSource = [
  'if (this._terminal.options.allowTransparency) {',
  "      // Preserve xterm's RGB blend while avoiding SRC_ALPHA being applied to",
  '      // alpha itself, which would turn configured opacity `a` into `a²`.',
  '      this._gl.blendFuncSeparate(',
  '        this._gl.SRC_ALPHA,',
  '        this._gl.ONE_MINUS_SRC_ALPHA,',
  '        this._gl.ONE,',
  '        this._gl.ONE_MINUS_SRC_ALPHA',
  '      );',
  '      this._gl.clearColor(0, 0, 0, 0);',
  '      this._gl.clear(this._gl.COLOR_BUFFER_BIT);',
  '    }'
].join('\n')
const transparentClearBundle =
  'this._terminal.options.allowTransparency&&(this._gl.blendFuncSeparate(this._gl.SRC_ALPHA,this._gl.ONE_MINUS_SRC_ALPHA,this._gl.ONE,this._gl.ONE_MINUS_SRC_ALPHA),this._gl.clearColor(0,0,0,0),this._gl.clear(this._gl.COLOR_BUFFER_BIT))'

describe('xterm transparent WebGL frame patch', () => {
  it("applies the transparent-only clear at xterm's renderer boundary", () => {
    const source = readFileSync(join(packageDir, 'src', 'WebglRenderer.ts'), 'utf8')
    const clearIndex = source.indexOf(transparentClearSource)
    const backgroundRenderIndex = source.indexOf(
      'this._rectangleRenderer.value.renderBackgrounds()',
      clearIndex
    )

    expect(clearIndex).toBeGreaterThan(-1)
    expect(backgroundRenderIndex).toBeGreaterThan(clearIndex)
  })

  it.each(['addon-webgl.js', 'addon-webgl.mjs'])(
    'keeps the generated %s runtime in parity with the source patch',
    (bundleName) => {
      const bundle = readFileSync(join(packageDir, 'lib', bundleName), 'utf8')
      const occurrences = bundle.split(transparentClearBundle).length - 1
      const clearIndex = bundle.indexOf(transparentClearBundle)
      const backgroundRenderIndex = bundle.indexOf(
        'this._rectangleRenderer.value.renderBackgrounds()',
        clearIndex
      )

      // Why: exactly one inline gate means one opacity-correct clear per transparent
      // xterm frame, zero for opaque frames, and no second lifecycle owner.
      expect(occurrences).toBe(1)
      expect(backgroundRenderIndex).toBeGreaterThan(clearIndex)
    }
  )
})
