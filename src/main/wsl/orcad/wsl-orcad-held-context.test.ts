import { runProcess } from '@orca/process-host'
import { describe, expect, it } from 'vitest'
import { readWslHostFacts, WSL_HOST_FACTS_COMMAND } from './wsl-orcad-held-context'

describe.skipIf(process.platform === 'win32')('WSL_HOST_FACTS_COMMAND under a real sh', () => {
  it('prints exactly the shape readWslHostFacts accepts', async () => {
    const result = await runProcess({
      program: 'sh',
      args: ['-c', WSL_HOST_FACTS_COMMAND],
      env: { ...process.env, HOME: '/home/orca user' },
      timeoutMs: 10_000
    })

    expect(readWslHostFacts(result.stdout)).toMatchObject({
      kernel: expect.stringMatching(/\S/),
      loginHome: '/home/orca user'
    })
  })
})
