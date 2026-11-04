import { describe, expect, it } from 'vitest'
import { contractProducerClosure, needsContractLint } from './phone-host-contract-lint-scope.mjs'

const RENDERER_OUTSIDE = 'src/renderer/src/components/AgentChildRowContent.tsx'
const IN_CLOSURE = 'src/main/runtime/rpc/e2ee-channel.ts'

describe('phone/host contract lint scope', () => {
  const closure = () => new Set([IN_CLOSURE])

  it.each([
    { name: 'a renderer-only change outside the producers', files: [RENDERER_OUTSIDE], run: false },
    { name: 'a change the producers reach', files: [RENDERER_OUTSIDE, IN_CLOSURE], run: true },
    { name: 'an ambient declaration', files: ['src/types/build-constants.d.ts'], run: true },
    {
      name: 'a contract body',
      files: ['src/main/codex/codex-url-opener-contract.test.ts'],
      run: true
    },
    { name: 'a phone file', files: ['mobile/src/transport/rpc-client.ts'], run: true },
    { name: 'an inherited program config', files: ['config/tsconfig.web.json'], run: true },
    { name: 'a deleted source', files: ['src/main/removed-in-this-change.ts'], run: true },
    { name: 'an empty diff', files: [], run: true }
  ])('$name: run=$run', ({ files, run }) => {
    expect(needsContractLint(files, undefined, closure)).toBe(run)
  })

  // The real producers reach the desktop transport, but not every renderer component.
  it('derives the closure from the producers through the unit dependency graph', () => {
    const real = contractProducerClosure()
    expect(real.has(IN_CLOSURE)).toBe(true)
    expect(real.has(RENDERER_OUTSIDE)).toBe(false)
  })
})
