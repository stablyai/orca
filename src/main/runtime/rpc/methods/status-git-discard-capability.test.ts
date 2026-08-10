import { describe, expect, it, vi } from 'vitest'
import {
  GIT_INDEX_PRESERVING_DISCARD_RUNTIME_CAPABILITY,
  GIT_STAGED_DISCARD_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { STATUS_METHODS } from './status'

const handler = STATUS_METHODS.find((method) => method.name === 'status.get')!.handler

function runtime(): OrcaRuntimeService {
  return {
    getRuntimeId: () => 'runtime-1',
    getStatus: vi.fn(() => ({ runtimeId: 'runtime-1', capabilities: [] }))
  } as unknown as OrcaRuntimeService
}

describe('Git discard runtime capability', () => {
  it('is advertised only when both authoritative handlers are registered', async () => {
    const result = (await handler(undefined, {
      runtime: runtime(),
      registeredMethods: new Set(['git.discardFromIndex', 'git.bulkDiscardFromIndex'])
    })) as { capabilities: string[] }

    expect(result.capabilities).toContain(GIT_INDEX_PRESERVING_DISCARD_RUNTIME_CAPABILITY)
  })

  it.each([
    { methods: [] },
    { methods: ['git.discardFromIndex'] },
    { methods: ['git.bulkDiscardFromIndex'] }
  ])('withholds the capability for an incomplete handler set', async ({ methods }) => {
    const result = (await handler(undefined, {
      runtime: runtime(),
      registeredMethods: new Set(methods)
    })) as { capabilities: string[] }

    expect(result.capabilities).not.toContain(GIT_INDEX_PRESERVING_DISCARD_RUNTIME_CAPABILITY)
  })

  it('advertises staged discard only when its authoritative handler is registered', async () => {
    const capable = (await handler(undefined, {
      runtime: runtime(),
      registeredMethods: new Set(['git.bulkDiscardStaged', 'git.getStagedDiscardReceipt'])
    })) as { capabilities: string[] }
    const legacy = (await handler(undefined, {
      runtime: runtime(),
      registeredMethods: new Set()
    })) as { capabilities: string[] }

    expect(capable.capabilities).toContain(GIT_STAGED_DISCARD_RUNTIME_CAPABILITY)
    expect(legacy.capabilities).not.toContain(GIT_STAGED_DISCARD_RUNTIME_CAPABILITY)
  })
})
