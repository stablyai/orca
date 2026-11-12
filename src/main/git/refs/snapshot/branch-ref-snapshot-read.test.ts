import { afterEach, expect, it, vi } from 'vitest'
const stream = vi.hoisted(() => vi.fn())
vi.mock('../../command-runner/git-stream-stdout', () => ({ gitStreamStdout: stream }))
import { readBranchRefSnapshot } from './branch-ref-snapshot-read'

afterEach(() => stream.mockReset())

it('keeps raw output complete under aggregate pressure and distinguishes an intrinsic bound', async () => {
  stream.mockImplementation(async (_args, options) => {
    for (const name of ['first', 'second']) {
      if (options.onStdout(`refs/heads/${name}\0${'a'.repeat(40)}\u00001\0\n`) === true) {
        return { stoppedEarly: true }
      }
    }
    return { stoppedEarly: false }
  })
  const page: string[] = []
  const pressured = await readBranchRefSnapshot(
    '/repo',
    {},
    (ref) => {
      page.push(ref.refName)
      return page.length === 2
    },
    undefined,
    { reserve: () => false, release: () => {} }
  )
  expect(page).toEqual(['refs/heads/first', 'refs/heads/second'])
  expect(pressured).toEqual({ snapshot: null, oversized: false })
  expect(await readBranchRefSnapshot('/repo', {}, () => true, 100)).toEqual({
    snapshot: null,
    oversized: true
  })
  const recovered = await readBranchRefSnapshot('/repo', {}, () => true)
  expect(recovered.snapshot?.refs.map((ref) => ref.refName)).toEqual([
    'refs/heads/first',
    'refs/heads/second'
  ])
})
