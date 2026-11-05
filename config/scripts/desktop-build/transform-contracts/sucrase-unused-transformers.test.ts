import { describe, expect, it } from 'vitest'
import { resolveSucraseUnusedTransformer } from '../../../build-plugins/sucrase-unused-transformers'

const ROOT_TRANSFORMER =
  '/Users/me/pnpm/store/v11/links/@/sucrase/3.35.1/abc/node_modules/sucrase/dist/esm/transformers/RootTransformer.js'
const CJS_ROOT_TRANSFORMER = ROOT_TRANSFORMER.replace('/esm', '')

describe('sucrase unused transformers stub', () => {
  it('stubs only the flow and react-hot-loader transformers sucrase itself imports', () => {
    expect(resolveSucraseUnusedTransformer('./FlowTransformer', ROOT_TRANSFORMER)).not.toBeNull()
    expect(
      resolveSucraseUnusedTransformer('./ReactHotLoaderTransformer.js', CJS_ROOT_TRANSFORMER)
    ).not.toBeNull()
    expect(
      resolveSucraseUnusedTransformer(
        './ReactHotLoaderTransformer',
        'C:\\x\\node_modules\\sucrase\\dist\\transformers\\RootTransformer.js'
      )
    ).not.toBeNull()
    expect(resolveSucraseUnusedTransformer('./JSXTransformer', ROOT_TRANSFORMER)).toBeNull()
    expect(
      resolveSucraseUnusedTransformer('./FlowTransformer', '/repo/src/main/flow.ts')
    ).toBeNull()
  })
})
