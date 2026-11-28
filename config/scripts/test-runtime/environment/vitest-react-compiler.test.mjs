import { afterEach, expect, it, vi } from 'vitest'
import { vitestReactCompiler } from '../../../build-plugins/vitest-react-compiler'

const SOURCE = `export function Strip({ items }: { items: string[] }) {
  const sorted = items.toSorted()
  return <ul>{sorted.map((item) => <li key={item}>{item}</li>)}</ul>
}
`

afterEach(() => {
  vi.unstubAllEnvs()
})

async function compile(id) {
  const result = await vitestReactCompiler()[0].transform.call({}, SOURCE, id)
  return result?.code ?? null
}

it('reads test markers below the renderer root, not in the checkout directory name', async () => {
  vi.stubEnv('ORCA_REACT_COMPILER', '1')
  // A worktree for a branch like fix/test-run lives in a directory named fix-test-run.
  const shipped = await compile('/work/fix-test-run/src/renderer/src/components/Strip.tsx')
  expect(String(shipped)).toContain('vitest-compiler-runtime-fallback')

  const harness = await compile('/work/orca/src/renderer/src/components/strip-test-harness.tsx')
  expect(harness).toBeNull()
})
